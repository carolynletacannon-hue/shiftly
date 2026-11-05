begin;

-- Coverage requirements are organization-owned configuration. Draft shifts now
-- represent persistent slots; an employee assignment is optional.
create unique index shift_templates_org_id_key
  on public.shift_templates(organization_id,id);

create table public.coverage_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  template_id uuid not null,
  weekday smallint not null check(weekday between 0 and 6),
  position_id uuid,
  required_count smallint not null default 1 check(required_count between 1 and 50),
  is_active boolean not null default true,
  revision integer not null default 1 check(revision > 0),
  created_at timestamptz not null default now(),
  foreign key(organization_id,template_id)
    references public.shift_templates(organization_id,id),
  foreign key(organization_id,position_id)
    references public.positions(organization_id,id)
);
create unique index coverage_requirements_org_id_key
  on public.coverage_requirements(organization_id,id);
create index coverage_requirements_org_day_idx
  on public.coverage_requirements(organization_id,weekday,is_active);
create index coverage_requirements_org_template_idx
  on public.coverage_requirements(organization_id,template_id);
create index coverage_requirements_org_position_idx
  on public.coverage_requirements(organization_id,position_id)
  where position_id is not null;

alter table public.shifts alter column employee_id drop not null;
alter table public.shifts
  add column label text not null default 'Custom shift'
    check(length(trim(label)) between 1 and 60),
  add column requirement_id uuid references public.coverage_requirements(id)
    on delete set null,
  add column template_id uuid references public.shift_templates(id)
    on delete set null,
  add column slot_ordinal smallint not null default 1 check(slot_ordinal > 0),
  add column is_required boolean not null default false,
  add column slot_kind text not null default 'legacy'
    check(slot_kind in ('legacy','requirement','one_off'));
create index shifts_requirement_idx
  on public.shifts(organization_id,requirement_id);
create index shifts_template_idx
  on public.shifts(template_id) where template_id is not null;
create unique index shifts_requirement_slot_key
  on public.shifts(schedule_id,requirement_id,slot_ordinal)
  where requirement_id is not null;

alter table public.published_shifts
  add column label text not null default 'Shift',
  add column position_id uuid,
  add column requirement_id uuid,
  add column template_id uuid,
  add column slot_ordinal smallint not null default 1,
  add column is_required boolean not null default false;

alter table public.coverage_requirements enable row level security;
create policy coverage_requirements_manager_read
  on public.coverage_requirements for select to authenticated
  using(public.workspace_role_for(organization_id) in ('owner','manager'));
revoke all on public.coverage_requirements from public,anon,authenticated;
grant select on public.coverage_requirements to authenticated;

create or replace function shiftly_private.validate_schedule(target uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare s public.schedules;
begin
  select * into strict s from public.schedules where id=target;
  if exists(
    select 1 from public.shifts d where d.schedule_id=target and (
      (d.starts_at at time zone s.timezone)::date<s.week_start or
      (d.starts_at at time zone s.timezone)::date>=s.week_start+7 or
      (d.ends_at at time zone s.timezone)-(d.starts_at at time zone s.timezone)>interval '24 hours' or
      (d.ends_at at time zone s.timezone)::date>(d.starts_at at time zone s.timezone)::date+1
    )
  ) then
    raise exception 'Shift must start in this week and end within the next day (maximum 24 local hours)';
  end if;
  if exists(
    select 1 from public.shifts a join public.shifts b on
      a.organization_id=b.organization_id and a.employee_id=b.employee_id and
      a.employee_id is not null and a.id<>b.id and
      a.starts_at<b.ends_at and b.starts_at<a.ends_at
    where a.schedule_id=target
  ) or exists(
    select 1 from public.shifts a join public.published_shifts b on
      a.organization_id=b.organization_id and a.employee_id=b.employee_id and
      a.employee_id is not null and a.schedule_id<>b.schedule_id and
      a.starts_at<b.ends_at and b.starts_at<a.ends_at
    where a.schedule_id=target
  ) then
    raise exception 'Employee has overlapping shifts. Check this and adjacent weeks';
  end if;
  if exists(
    select 1 from public.shifts a left join public.memberships m on
      m.organization_id=a.organization_id and m.user_id=a.employee_id
    where a.schedule_id=target and a.employee_id is not null and m.user_id is null
  ) then
    raise exception 'Assigned employee is no longer a member';
  end if;
end $$;

create or replace function shiftly_private.schedule_command(
  org uuid,
  command text,
  payload jsonb,
  expected_revision integer default null
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  s public.schedules;
  target uuid;
  result uuid;
  current_version integer;
  item jsonb;
  copied jsonb;
  local_week date;
  tz text;
  affected_rows integer;
  req record;
  ordinal integer;
  slot_date date;
  local_start timestamp;
  local_end timestamp;
  slot_start timestamptz;
  slot_end timestamptz;
  missing_slots integer;
  assignment uuid;
begin
  if auth.uid() is null or coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then
    raise exception 'Schedule permission denied';
  end if;
  perform 1 from public.organizations where id=org for no key update;
  if coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then
    raise exception 'Schedule permission denied';
  end if;

  if command='create' then
    local_week:=(payload->>'week_start')::date;
    select timezone into tz from public.organizations where id=org;
    if local_week is null or extract(dow from local_week)::integer<>
      (select coalesce((settings->>'week_starts_on')::integer,0) from public.organizations where id=org)
    then raise exception 'Choose the workspace week start'; end if;
    if exists(select 1 from public.schedules where organization_id=org and week_start=local_week) then
      raise exception 'A draft already exists. Refresh before editing';
    end if;
    insert into public.schedules(organization_id,week_start,timezone,created_by)
      values(org,local_week,tz,auth.uid()) returning * into s;

    -- Example templates are seeded once per organization and remain editable.
    -- No coverage requirement is created unless a manager configures one.
    insert into public.schedule_settings(organization_id) values(org) on conflict do nothing;
    get diagnostics affected_rows=row_count;
    if affected_rows>0 then
      insert into public.shift_templates(organization_id,name,start_time,end_time,end_next_day) values
        (org,'Morning','07:00','15:00',false),
        (org,'Evening','15:00','23:00',false),
        (org,'Overnight','23:00','07:00',true)
      on conflict do nothing;
    end if;

    for req in
      select r.*,t.name,t.start_time,t.end_time,t.end_next_day,
        coalesce(r.position_id,t.position_id) as resolved_position
      from public.coverage_requirements r
      join public.shift_templates t on t.organization_id=r.organization_id and t.id=r.template_id
      where r.organization_id=org and r.is_active
      order by r.weekday,t.start_time,r.id
    loop
      slot_date:=local_week+((req.weekday-extract(dow from local_week)::integer+7)%7);
      local_start:=slot_date::timestamp+req.start_time;
      local_end:=(slot_date+case when req.end_next_day then 1 else 0 end)::timestamp+req.end_time;
      slot_start:=local_start at time zone tz;
      slot_end:=local_end at time zone tz;
      if slot_start at time zone tz<>local_start or slot_end at time zone tz<>local_end then
        raise exception 'A required slot falls in a skipped daylight-saving hour';
      end if;
      for ordinal in 1..req.required_count loop
        insert into public.shifts(
          organization_id,schedule_id,employee_id,position_id,starts_at,ends_at,notes,
          label,requirement_id,template_id,slot_ordinal,is_required,slot_kind
        ) values(
          org,s.id,null,req.resolved_position,slot_start,slot_end,'',req.name,
          req.id,req.template_id,ordinal,true,'requirement'
        );
      end loop;
    end loop;

    copied:=coalesce(payload->'slots',payload->'shifts','[]'::jsonb);
    if jsonb_typeof(copied)<>'array' or jsonb_array_length(copied)>300 then
      raise exception 'Invalid copied shifts';
    end if;
    for item in select value from jsonb_array_elements(copied) loop
      if nullif(item->>'requirement_id','') is not null then
        update public.shifts set
          employee_id=nullif(item->>'employee_id','')::uuid,
          notes=coalesce(item->>'notes','')
        where schedule_id=s.id
          and requirement_id=(item->>'requirement_id')::uuid
          and slot_ordinal=coalesce((item->>'slot_ordinal')::integer,1);
        if found then continue; end if;
      end if;
      if coalesce((item->>'is_required')::boolean,false) then continue; end if;
      insert into public.shifts(
        organization_id,schedule_id,employee_id,position_id,starts_at,ends_at,notes,
        label,template_id,slot_ordinal,is_required,slot_kind
      ) values(
        org,s.id,nullif(item->>'employee_id','')::uuid,
        nullif(item->>'position_id','')::uuid,
        (item->>'starts_at')::timestamptz,(item->>'ends_at')::timestamptz,
        coalesce(item->>'notes',''),coalesce(nullif(trim(item->>'label'),''),'Custom shift'),
        nullif(item->>'template_id','')::uuid,1,false,'one_off'
      );
    end loop;
    perform shiftly_private.validate_schedule(s.id);
    return jsonb_build_object('id',s.id,'revision',s.revision);

  elsif command in ('template_save','template_delete') then
    target:=nullif(payload->>'id','')::uuid;
    if target is not null then
      select revision into current_version from public.shift_templates
        where organization_id=org and id=target for update;
      if current_version is null then raise exception 'Template unavailable'; end if;
      if expected_revision is distinct from current_version then
        raise exception 'Stale revision. Refresh before editing';
      end if;
    end if;
    if command='template_delete' then
      delete from public.shift_templates where organization_id=org and id=target;
      if not found then raise exception 'Template unavailable'; end if;
      return '{}'::jsonb;
    elsif target is null then
      insert into public.shift_templates(organization_id,name,start_time,end_time,end_next_day,position_id)
      values(org,trim(payload->>'name'),(payload->>'start_time')::time,
        (payload->>'end_time')::time,(payload->>'end_next_day')::boolean,
        nullif(payload->>'position_id','')::uuid) returning id into result;
    else
      update public.shift_templates set
        name=trim(payload->>'name'),start_time=(payload->>'start_time')::time,
        end_time=(payload->>'end_time')::time,
        end_next_day=(payload->>'end_next_day')::boolean,
        position_id=nullif(payload->>'position_id','')::uuid,revision=revision+1
      where id=target returning id into result;
    end if;
    return jsonb_build_object('id',result);

  elsif command in ('requirement_save','requirement_delete') then
    target:=nullif(payload->>'id','')::uuid;
    if target is not null then
      select revision into current_version from public.coverage_requirements
        where organization_id=org and id=target for update;
      if current_version is null then raise exception 'Coverage requirement unavailable'; end if;
      if expected_revision is distinct from current_version then
        raise exception 'Stale revision. Refresh before editing';
      end if;
    end if;
    if command='requirement_delete' then
      delete from public.coverage_requirements where organization_id=org and id=target;
      if not found then raise exception 'Coverage requirement unavailable'; end if;
      return '{}'::jsonb;
    elsif target is null then
      insert into public.coverage_requirements(
        organization_id,template_id,weekday,position_id,required_count,is_active
      ) values(
        org,(payload->>'template_id')::uuid,(payload->>'weekday')::smallint,
        nullif(payload->>'position_id','')::uuid,(payload->>'required_count')::smallint,
        coalesce((payload->>'is_active')::boolean,true)
      ) returning id into result;
    else
      update public.coverage_requirements set
        template_id=(payload->>'template_id')::uuid,
        weekday=(payload->>'weekday')::smallint,
        position_id=nullif(payload->>'position_id','')::uuid,
        required_count=(payload->>'required_count')::smallint,
        is_active=coalesce((payload->>'is_active')::boolean,true),
        revision=revision+1
      where id=target returning id into result;
    end if;
    return jsonb_build_object('id',result);

  elsif command='settings' then
    select revision into current_version from public.schedule_settings
      where organization_id=org for update;
    if expected_revision is distinct from current_version then
      raise exception 'Stale revision. Refresh before editing';
    end if;
    if current_version is null then raise exception 'Create a draft before configuring weekly hours'; end if;
    update public.schedule_settings set
      weekly_hours_warning=(payload->>'weekly_hours_warning')::numeric,
      revision=revision+1 where organization_id=org;
    return '{}'::jsonb;
  elsif command='position' then
    insert into public.positions(organization_id,name)
      values(org,trim(payload->>'name')) returning id into result;
    return jsonb_build_object('id',result);
  end if;

  select * into s from public.schedules
    where organization_id=org and id=(payload->>'schedule_id')::uuid for update;
  if s.id is null then raise exception 'Schedule unavailable'; end if;
  if expected_revision is distinct from s.revision then
    raise exception 'Stale revision. Refresh before editing';
  end if;

  if command in ('save','slot_save') then
    target:=nullif(payload->>'id','')::uuid;
    assignment:=nullif(payload->>'employee_id','')::uuid;
    if command='save' and assignment is null then raise exception 'Choose an employee'; end if;
    if target is null then
      if (select count(*) from public.shifts where schedule_id=s.id)>=300 then
        raise exception 'Weekly shift limit reached';
      end if;
      insert into public.shifts(
        organization_id,schedule_id,employee_id,position_id,starts_at,ends_at,notes,
        label,template_id,is_required,slot_kind
      ) values(
        org,s.id,assignment,nullif(payload->>'position_id','')::uuid,
        (payload->>'starts_at')::timestamptz,(payload->>'ends_at')::timestamptz,
        coalesce(payload->>'notes',''),coalesce(nullif(trim(payload->>'label'),''),'Custom shift'),
        nullif(payload->>'template_id','')::uuid,false,'one_off'
      ) returning id into result;
    else
      if command='slot_save' and exists(
        select 1 from public.shifts where id=target and schedule_id=s.id and is_required
      ) then raise exception 'Required slot structure is managed by its coverage requirement'; end if;
      update public.shifts set
        employee_id=assignment,position_id=nullif(payload->>'position_id','')::uuid,
        starts_at=(payload->>'starts_at')::timestamptz,
        ends_at=(payload->>'ends_at')::timestamptz,
        notes=coalesce(payload->>'notes',''),
        label=coalesce(nullif(trim(payload->>'label'),''),label),
        template_id=nullif(payload->>'template_id','')::uuid
      where id=target and organization_id=org and schedule_id=s.id returning id into result;
      if result is null then raise exception 'Shift unavailable'; end if;
    end if;
    perform shiftly_private.validate_schedule(s.id);
  elsif command='assign' then
    target:=(payload->>'id')::uuid;
    assignment:=nullif(payload->>'employee_id','')::uuid;
    update public.shifts set employee_id=assignment
      where id=target and organization_id=org and schedule_id=s.id returning id into result;
    if result is null then raise exception 'Shift unavailable'; end if;
    perform shiftly_private.validate_schedule(s.id);
  elsif command='delete' then
    target:=(payload->>'id')::uuid;
    if exists(select 1 from public.shifts where id=target and schedule_id=s.id and is_required) then
      raise exception 'Required slots cannot be removed from an existing week';
    end if;
    delete from public.shifts where id=target and organization_id=org and schedule_id=s.id;
    if not found then raise exception 'Shift unavailable'; end if;
  elsif command='publish' then
    if s.published_revision=s.revision then raise exception 'No unpublished changes'; end if;
    perform shiftly_private.validate_schedule(s.id);
    select count(*)::integer into missing_slots from public.shifts
      where schedule_id=s.id and is_required and employee_id is null;
    if missing_slots>0 and not coalesce((payload->>'allow_incomplete')::boolean,false) then
      raise exception 'Unfilled required slots. Confirm incomplete publication';
    end if;
    insert into public.published_schedules(
      id,organization_id,week_start,timezone,revision,published_by
    ) values(s.id,org,s.week_start,s.timezone,s.revision,auth.uid())
    on conflict(id) do update set
      revision=excluded.revision,published_at=now(),published_by=excluded.published_by;
    delete from public.published_shifts where schedule_id=s.id;
    insert into public.published_shifts(
      id,organization_id,schedule_id,employee_id,position_name,starts_at,ends_at,notes,
      label,position_id,requirement_id,template_id,slot_ordinal,is_required
    )
    select d.id,org,s.id,d.employee_id,coalesce(p.name,'General'),d.starts_at,d.ends_at,d.notes,
      d.label,d.position_id,d.requirement_id,d.template_id,d.slot_ordinal,d.is_required
    from public.shifts d
    left join public.positions p on p.id=d.position_id and p.organization_id=org
    where d.schedule_id=s.id and d.employee_id is not null;
    update public.schedules set published_revision=revision where id=s.id;
    insert into public.schedule_events(organization_id,schedule_id,revision,event_type,actor_id)
      values(org,s.id,s.revision,'schedule.published',auth.uid());
    return jsonb_build_object('id',s.id,'revision',s.revision,'unfilled',missing_slots);
  else
    raise exception 'Unknown scheduling command';
  end if;

  update public.schedules set revision=revision+1,updated_at=now()
    where id=s.id returning revision into current_version;
  return jsonb_build_object('id',coalesce(result,s.id),'revision',current_version);
end $$;

commit;
