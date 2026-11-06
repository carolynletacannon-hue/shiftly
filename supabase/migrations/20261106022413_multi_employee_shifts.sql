begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
-- Match the command lock order before locking assignment/publication tables.
-- Readers remain available. Retry the migration during a quiet window on timeout.
lock table public.organizations in exclusive mode;
-- Existing `shifts` rows become assignment slots. Their primary keys remain
-- stable for integrations and future request references. Shared shift identity,
-- staffing policy and structure live in this parent relation.
create table public.shift_groups (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 schedule_id uuid not null,
 position_id uuid,
 starts_at timestamptz not null,
 ends_at timestamptz not null,
 label text not null check(length(trim(label)) between 1 and 60),
 notes text not null default '' check(length(notes)<=300),
 requirement_id uuid,
 template_id uuid,
 is_required boolean not null default false,
 required_count integer not null default 1 check(required_count between 1 and 50),
 allow_overstaffing boolean not null default true,
 unique(organization_id,schedule_id,id),
 foreign key(organization_id,schedule_id) references public.schedules(organization_id,id) on delete cascade,
 foreign key(organization_id,position_id) references public.positions(organization_id,id),
 foreign key(organization_id,requirement_id) references public.coverage_requirements(organization_id,id) on delete set null (requirement_id),
 foreign key(organization_id,template_id) references public.shift_templates(organization_id,id) on delete set null (template_id),
 check(isfinite(starts_at) and isfinite(ends_at) and ends_at>starts_at and ends_at-starts_at<=interval '26 hours')
);
create index shift_groups_schedule_idx on public.shift_groups(organization_id,schedule_id);
create index shift_groups_template_idx on public.shift_groups(organization_id,template_id) where template_id is not null;
create index shift_groups_requirement_idx on public.shift_groups(organization_id,requirement_id);
alter table public.shifts add column shift_group_id uuid;
alter table public.published_shifts add column shift_group_id uuid;
alter table public.published_shifts add column required_count integer not null default 1;
alter table public.published_shifts add column allow_overstaffing boolean not null default true;
-- Only siblings from the SAME recurring requirement with identical structure
-- merge. Custom/legacy rows, differing labels, notes, positions and times do not.
with mapped as (
 select id,case when requirement_id is not null and slot_kind='requirement' then
 first_value(id) over(partition by organization_id,schedule_id,requirement_id,
 template_id,starts_at,ends_at,position_id,label,notes,is_required order by slot_ordinal,id)
 else id end parent from public.shifts
) update public.shifts s set shift_group_id=m.parent from mapped m where s.id=m.id;
insert into public.shift_groups(id,organization_id,schedule_id,position_id,starts_at,ends_at,label,notes,requirement_id,template_id,is_required,required_count)
 select s.shift_group_id,s.organization_id,s.schedule_id,s.position_id,s.starts_at,s.ends_at,s.label,s.notes,s.requirement_id,s.template_id,s.is_required,
 least(count(*),50)::integer from public.shifts s group by s.shift_group_id,s.organization_id,s.schedule_id,s.position_id,s.starts_at,s.ends_at,s.label,s.notes,s.requirement_id,s.template_id,s.is_required;
-- Published membership is derived exclusively from the old snapshot, never the
-- current draft. No snapshot employee, timestamp, revision or id is overwritten.
with mapped as (
 select id,case when requirement_id is not null then first_value(id) over(
 partition by organization_id,schedule_id,requirement_id,template_id,starts_at,ends_at,position_id,position_name,label,notes,is_required order by slot_ordinal,id)
 else id end parent from public.published_shifts
) update public.published_shifts s set shift_group_id=m.parent from mapped m where s.id=m.id;
with counts as (select shift_group_id,count(*)::integer n from public.published_shifts group by shift_group_id)
 update public.published_shifts s set required_count=c.n from counts c where s.shift_group_id=c.shift_group_id;
alter table public.shifts alter column shift_group_id set not null;
alter table public.published_shifts alter column shift_group_id set not null;
alter table public.shifts add constraint shifts_group_fkey foreign key(organization_id,schedule_id,shift_group_id)
 references public.shift_groups(organization_id,schedule_id,id);
create index shifts_group_idx on public.shifts(organization_id,schedule_id,shift_group_id);
create index published_shifts_group_idx on public.published_shifts(organization_id,schedule_id,shift_group_id);
-- A real relational assignment API; the old table name remains compatible.
create view public.shift_assignments with(security_invoker=true) as
 select id,organization_id,schedule_id,shift_group_id,employee_id from public.shifts where employee_id is not null;
alter table public.shift_groups enable row level security;
create policy shift_groups_manager_read on public.shift_groups for select to authenticated
 using(public.workspace_role_for(organization_id) in ('owner','manager'));
revoke all on public.shift_groups,public.shift_assignments from public,anon,authenticated;
grant select on public.shift_groups,public.shift_assignments to authenticated;

-- Compatibility projections retain the existing overlap validator and publication
-- pipeline. Only the locked command API can mutate either side of the relation.
create function shiftly_private.attach_shift_group() returns trigger
language plpgsql security invoker set search_path='' as $$
declare parent uuid;
begin
 if new.shift_group_id is null then
   if new.requirement_id is not null and new.slot_kind='requirement' then
     select g.id into parent from public.shift_groups g where g.organization_id=new.organization_id
       and g.schedule_id=new.schedule_id and g.requirement_id=new.requirement_id
       and g.template_id is not distinct from new.template_id and g.starts_at=new.starts_at and g.ends_at=new.ends_at
       and g.position_id is not distinct from new.position_id and g.label=new.label and g.notes=new.notes and g.is_required=new.is_required
       order by g.id limit 1;
   end if;
   new.shift_group_id:=coalesce(parent,new.id);
 end if;
 if not exists(select 1 from public.shift_groups where id=new.shift_group_id) then
   insert into public.shift_groups(id,organization_id,schedule_id,position_id,starts_at,ends_at,label,notes,requirement_id,template_id,is_required,required_count)
   values(new.shift_group_id,new.organization_id,new.schedule_id,new.position_id,new.starts_at,new.ends_at,new.label,new.notes,new.requirement_id,new.template_id,new.is_required,
     case when new.is_required then coalesce((select required_count from public.coverage_requirements where id=new.requirement_id),1) else 1 end)
   on conflict(id) do nothing;
 end if;
 return new;
end $$;
revoke all on function shiftly_private.attach_shift_group() from public,anon,authenticated;
create trigger attach_shift_group before insert on public.shifts for each row execute function shiftly_private.attach_shift_group();

create table public.assignment_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations on delete cascade,
 schedule_id uuid not null, revision integer not null, assignment_id uuid not null,
 shift_group_id uuid not null, previous_employee_id uuid, employee_id uuid, actor_id uuid,
 before_snapshot jsonb, after_snapshot jsonb,
 created_at timestamptz not null default now(),
 foreign key(organization_id,schedule_id) references public.schedules(organization_id,id) on delete cascade
);
create index assignment_events_org_idx on public.assignment_events(organization_id,schedule_id,revision);
alter table public.assignment_events enable row level security;
create policy assignment_events_manager_read on public.assignment_events for select to authenticated
 using(public.workspace_role_for(organization_id) in ('owner','manager'));
revoke all on public.assignment_events from public,anon,authenticated;
grant select on public.assignment_events to authenticated;
-- Deferred triggers execute after the command's definer context ends. This
-- private, non-callable audit sink therefore owns its INSERT privilege, while
-- still requiring a current authenticated organization member as the actor.
create function shiftly_private.audit_assignment() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (tg_op='INSERT' and new.employee_id is not null) or
    (tg_op='UPDATE' and to_jsonb(new) is distinct from to_jsonb(old)) or
    (tg_op='DELETE' and old.employee_id is not null) then
 if auth.uid() is null or public.workspace_role_for(coalesce(new.organization_id,old.organization_id)) is null then
   raise exception 'Audit actor must be an authenticated workspace member';
 end if;
 insert into public.assignment_events(organization_id,schedule_id,revision,assignment_id,shift_group_id,previous_employee_id,employee_id,actor_id,before_snapshot,after_snapshot)
 select coalesce(new.organization_id,old.organization_id),s.id,s.revision,coalesce(new.id,old.id),
 coalesce(new.shift_group_id,old.shift_group_id),case when tg_op<>'INSERT' then old.employee_id end,
 case when tg_op<>'DELETE' then new.employee_id end,auth.uid(),
 case when tg_op<>'INSERT' then to_jsonb(old) end,case when tg_op<>'DELETE' then to_jsonb(new) end
 from public.schedules s where s.id=coalesce(new.schedule_id,old.schedule_id);
 end if;
 return null;
end $$;
revoke all on function shiftly_private.audit_assignment() from public,anon,authenticated;
-- Defer audit materialization until the transaction has its committed revision.
create constraint trigger audit_assignment after insert or update or delete on public.shifts
 deferrable initially deferred for each row execute function shiftly_private.audit_assignment();

create table public.schedule_changes (
 organization_id uuid not null, schedule_id uuid not null, revision integer not null,
 command text not null, payload jsonb not null, actor_id uuid not null references public.profiles,
 created_at timestamptz not null default now(), primary key(schedule_id,revision),
 foreign key(organization_id,schedule_id) references public.schedules(organization_id,id) on delete cascade
);
create index schedule_changes_org_idx on public.schedule_changes(organization_id,schedule_id,revision);
alter table public.schedule_changes enable row level security;
create policy schedule_changes_manager_read on public.schedule_changes for select to authenticated
 using(public.workspace_role_for(organization_id) in ('owner','manager'));
revoke all on public.schedule_changes from public,anon,authenticated;
grant select on public.schedule_changes to authenticated;

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
    select 1 from public.shifts a left join public.employees m on
      m.organization_id=a.organization_id and m.id=a.employee_id
    where a.schedule_id=target and a.employee_id is not null and m.id is null
  ) then
    raise exception 'Assigned employee is unavailable';
  end if;
  if (select count(*) from public.shifts where schedule_id=target)>300 then raise exception 'Weekly shift limit reached'; end if;
  if exists(select 1 from public.shift_groups g where g.schedule_id=target and not g.allow_overstaffing
    and (select count(*) from public.shifts a where a.shift_group_id=g.id and a.employee_id is not null)>g.required_count)
  then raise exception 'This shift does not permit overstaffing'; end if;
  if exists(select 1 from public.shifts a join public.shift_groups g on g.id=a.shift_group_id where a.schedule_id=target and
    (a.starts_at<>g.starts_at or a.ends_at<>g.ends_at or a.label<>g.label or a.notes<>g.notes or a.position_id is distinct from g.position_id))
  then raise exception 'Shared shift structure must be edited together'; end if;
end $$;




-- Capacity is a parent attribute. Vacant assignment slots are materialized for
-- the existing employee volunteering API, never as separate calendar shifts.
create function shiftly_private.sync_group_slots(target uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare parent public.shift_groups; n integer; ordinal integer;
begin
 select * into strict parent from public.shift_groups where id=target;
 select count(*) into n from public.shifts where shift_group_id=target;
 while n<parent.required_count loop
   select coalesce(max(slot_ordinal),0)+1 into ordinal from public.shifts
     where schedule_id=parent.schedule_id and requirement_id=parent.requirement_id;
   insert into public.shifts(organization_id,schedule_id,shift_group_id,position_id,starts_at,ends_at,label,notes,requirement_id,template_id,is_required,slot_kind,slot_ordinal)
   values(parent.organization_id,parent.schedule_id,parent.id,parent.position_id,parent.starts_at,parent.ends_at,parent.label,parent.notes,
     parent.requirement_id,parent.template_id,parent.is_required,case when parent.is_required then 'requirement' else 'one_off' end,ordinal);
   n:=n+1;
 end loop;
 -- Never delete an existing assignment identity here. Empty legacy/published
 -- slots may be referenced by pending requests. Extra vacancies remain dormant
 -- when the current staffing policy prohibits additional people.
end $$;
revoke all on function shiftly_private.sync_group_slots(uuid) from public,anon,authenticated;

create function shiftly_private.attach_published_group() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.shift_group_id is null then
   select a.shift_group_id,g.required_count,g.allow_overstaffing into new.shift_group_id,new.required_count,new.allow_overstaffing
   from public.shifts a join public.shift_groups g on g.id=a.shift_group_id where a.id=new.id and a.organization_id=new.organization_id;
   new.shift_group_id:=coalesce(new.shift_group_id,new.id);
   new.required_count:=coalesce(new.required_count,1);
   new.allow_overstaffing:=coalesce(new.allow_overstaffing,true);
 end if;
 return new;
end $$;
revoke all on function shiftly_private.attach_published_group() from public,anon,authenticated;
create trigger attach_published_group before insert on public.published_shifts for each row execute function shiftly_private.attach_published_group();

-- Enrich pending request snapshots with ONLY the newly introduced keys. The old
-- snapshot contents and revisions remain intact, so genuinely stale requests
-- stay stale while valid coworker consents can still complete after migration.
update public.shift_requests r set source_snapshot=r.source_snapshot||jsonb_build_object(
 'shift_group_id',s.shift_group_id,'required_count',s.required_count,'allow_overstaffing',s.allow_overstaffing)
 from public.published_shifts s where s.organization_id=r.organization_id and s.id=r.shift_id and r.status in ('open','pending');
update public.shift_requests r set other_snapshot=r.other_snapshot||jsonb_build_object(
 'shift_group_id',s.shift_group_id,'required_count',s.required_count,'allow_overstaffing',s.allow_overstaffing)
 from public.published_shifts s where s.organization_id=r.organization_id and s.id=r.other_shift_id and r.other_snapshot is not null and r.status in ('open','pending');

-- Unassigned published places still use their stable assignment id. Reject a
-- volunteer for a full group when its frozen publication disallows overstaffing.
create function shiftly_private.check_published_capacity() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.employee_id is not null and not new.allow_overstaffing and
   (select count(*) from public.published_shifts a where a.organization_id=new.organization_id
    and a.schedule_id=new.schedule_id and a.shift_group_id=new.shift_group_id and a.employee_id is not null and a.id<>new.id)>=new.required_count
 then raise exception 'This shift does not permit overstaffing'; end if;
 return new;
end $$;
revoke all on function shiftly_private.check_published_capacity() from public,anon,authenticated;
create trigger check_published_capacity before insert or update on public.published_shifts for each row execute function shiftly_private.check_published_capacity();

-- Transfers can touch a frozen vacant publication after the manager lowers the
-- draft limit. Enforce the current draft policy at that assignment boundary too.
create function shiftly_private.check_assignment_capacity() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.employee_id is null then return new; end if;
 if tg_op='UPDATE' and new.employee_id is not distinct from old.employee_id then return new; end if;
 if exists(select 1 from public.shift_groups g where g.id=new.shift_group_id and not g.allow_overstaffing
   and (select count(*) from public.shifts a where a.shift_group_id=g.id and a.employee_id is not null and a.id<>new.id)>=g.required_count)
 then raise exception 'This shift does not permit overstaffing'; end if;
 return new;
end $$;
revoke all on function shiftly_private.check_assignment_capacity() from public,anon,authenticated;
create trigger check_assignment_capacity before insert or update on public.shifts for each row execute function shiftly_private.check_assignment_capacity();

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
  copied_groups jsonb:='{}';
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
  group_target uuid;
  group_row public.shift_groups;
  assigned_count integer;
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
        select g.id into group_target from public.shift_groups g where g.schedule_id=s.id
          and g.requirement_id=(item->>'requirement_id')::uuid
          and g.starts_at=(item->>'starts_at')::timestamptz and g.ends_at=(item->>'ends_at')::timestamptz
          and g.label=coalesce(item->>'label','') and g.notes=coalesce(item->>'notes','')
          and g.position_id is not distinct from nullif(item->>'position_id','')::uuid
          order by g.id limit 1;
        if group_target is not null then
          update public.shifts set employee_id=nullif(item->>'employee_id','')::uuid
          where shift_group_id=group_target and slot_ordinal=coalesce((item->>'slot_ordinal')::integer,1);
          if not found and nullif(item->>'employee_id','') is not null then
            insert into public.shifts(organization_id,schedule_id,shift_group_id,employee_id,position_id,starts_at,ends_at,notes,label,requirement_id,template_id,slot_ordinal,is_required,slot_kind)
            select org,s.id,g.id,(item->>'employee_id')::uuid,g.position_id,g.starts_at,g.ends_at,g.notes,g.label,g.requirement_id,g.template_id,
              (select coalesce(max(slot_ordinal),0)+1 from public.shifts where schedule_id=s.id and requirement_id=g.requirement_id),true,'requirement'
            from public.shift_groups g where g.id=group_target;
          end if;
          continue;
        end if;
      end if;
      group_target:=null;
      if nullif(item->>'copy_group_key','') is not null then
        group_target:=(copied_groups->>(item->>'copy_group_key'))::uuid;
        if group_target is null then
          group_target:=gen_random_uuid();
          copied_groups:=copied_groups||jsonb_build_object(item->>'copy_group_key',group_target);
        end if;
      end if;
      insert into public.shifts(
        organization_id,schedule_id,employee_id,position_id,starts_at,ends_at,notes,
        label,template_id,slot_ordinal,is_required,slot_kind,shift_group_id
      ) values(
        org,s.id,nullif(item->>'employee_id','')::uuid,
        nullif(item->>'position_id','')::uuid,
        (item->>'starts_at')::timestamptz,(item->>'ends_at')::timestamptz,
        coalesce(item->>'notes',''),coalesce(nullif(trim(item->>'label'),''),'Custom shift'),
        nullif(item->>'template_id','')::uuid,1,false,'one_off',group_target
      );
      if group_target is not null then
        update public.shift_groups set required_count=coalesce((item->>'required_count')::integer,1),
          allow_overstaffing=coalesce((item->>'allow_overstaffing')::boolean,true) where id=group_target;
      end if;
    end loop;
    perform shiftly_private.validate_schedule(s.id);
    insert into public.schedule_changes(organization_id,schedule_id,revision,command,payload,actor_id)
      values(org,s.id,s.revision,'create',payload-'slots'-'shifts',auth.uid());
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

  if command in ('group_save','group_assign','group_staffing','group_delete') then
    group_target:=nullif(payload->>'shift_group_id','')::uuid;
    if group_target is not null then
      select * into group_row from public.shift_groups where id=group_target and organization_id=org and schedule_id=s.id for update;
      if group_row.id is null or not exists(select 1 from public.shifts where shift_group_id=group_target) then raise exception 'Shift unavailable'; end if;
    elsif command<>'group_save' then raise exception 'Choose a shift'; end if;
    if command='group_save' then
      if group_target is null then
        insert into public.shift_groups(organization_id,schedule_id,position_id,starts_at,ends_at,label,notes,template_id,required_count,allow_overstaffing)
        values(org,s.id,nullif(payload->>'position_id','')::uuid,(payload->>'starts_at')::timestamptz,(payload->>'ends_at')::timestamptz,
          trim(payload->>'label'),coalesce(payload->>'notes',''),nullif(payload->>'template_id','')::uuid,
          coalesce((payload->>'required_count')::integer,1),coalesce((payload->>'allow_overstaffing')::boolean,true)) returning id into group_target;
        insert into public.shifts(organization_id,schedule_id,shift_group_id,employee_id,position_id,starts_at,ends_at,label,notes,template_id,slot_kind)
        select org,s.id,g.id,nullif(payload->>'employee_id','')::uuid,g.position_id,g.starts_at,g.ends_at,g.label,g.notes,g.template_id,'one_off'
        from public.shift_groups g where g.id=group_target;
      else
        update public.shift_groups set position_id=nullif(payload->>'position_id','')::uuid,
          starts_at=(payload->>'starts_at')::timestamptz,ends_at=(payload->>'ends_at')::timestamptz,
          label=trim(payload->>'label'),notes=coalesce(payload->>'notes',''),template_id=nullif(payload->>'template_id','')::uuid,
          required_count=coalesce((payload->>'required_count')::integer,required_count),
          allow_overstaffing=coalesce((payload->>'allow_overstaffing')::boolean,allow_overstaffing)
          where id=group_target;
        -- Shared structure changes together. Assignment membership is unchanged.
        update public.shifts a set position_id=g.position_id,starts_at=g.starts_at,ends_at=g.ends_at,
          label=g.label,notes=g.notes,template_id=g.template_id
          from public.shift_groups g where a.shift_group_id=g.id and g.id=group_target;
      end if;
    elsif command='group_assign' then
      assignment:=nullif(payload->>'employee_id','')::uuid;
      target:=nullif(payload->>'assignment_id','')::uuid;
      if target is not null then
        -- Removal/replacement is scoped to exactly one participating assignment.
        update public.shifts set employee_id=assignment where id=target and shift_group_id=group_target returning id into result;
        if result is null then raise exception 'Assignment unavailable'; end if;
      elsif assignment is not null then
        select id into target from public.shifts where shift_group_id=group_target and employee_id is null order by slot_ordinal,id limit 1;
        if target is not null then
          update public.shifts set employee_id=assignment where id=target returning id into result;
        else
          insert into public.shifts(organization_id,schedule_id,shift_group_id,employee_id,position_id,starts_at,ends_at,label,notes,requirement_id,template_id,slot_ordinal,is_required,slot_kind)
          select org,s.id,g.id,assignment,g.position_id,g.starts_at,g.ends_at,g.label,g.notes,g.requirement_id,g.template_id,
            coalesce((select max(slot_ordinal)+1 from public.shifts where schedule_id=s.id and requirement_id=g.requirement_id),1),g.is_required,
            case when g.is_required then 'requirement' else 'one_off' end from public.shift_groups g where g.id=group_target returning id into result;
        end if;
      else raise exception 'Choose an employee or an assignment to remove'; end if;
    elsif command='group_staffing' then
      update public.shift_groups set required_count=(payload->>'required_count')::integer,
        allow_overstaffing=coalesce((payload->>'allow_overstaffing')::boolean,allow_overstaffing) where id=group_target;
    else
      delete from public.shifts where shift_group_id=group_target;
      delete from public.shift_groups where id=group_target;
    end if;
    if command<>'group_delete' then perform shiftly_private.sync_group_slots(group_target); end if;
    result:=coalesce(result,group_target);
    perform shiftly_private.validate_schedule(s.id);
  elsif command in ('save','slot_save') then
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
    select shift_group_id into group_target from public.shifts where id=result;
    update public.shift_groups g set position_id=a.position_id,starts_at=a.starts_at,ends_at=a.ends_at,
      label=a.label,notes=a.notes,template_id=a.template_id from public.shifts a where a.id=result and g.id=a.shift_group_id;
    update public.shifts a set position_id=g.position_id,starts_at=g.starts_at,ends_at=g.ends_at,
      label=g.label,notes=g.notes,template_id=g.template_id from public.shift_groups g where a.shift_group_id=g.id and g.id=group_target;
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
    for group_target in select distinct shift_group_id from public.shifts where schedule_id=s.id loop
      perform shiftly_private.sync_group_slots(group_target);
    end loop;
    perform shiftly_private.validate_schedule(s.id);
    select coalesce(sum(greatest(0,g.required_count-(select count(*) from public.shifts a where a.shift_group_id=g.id and a.employee_id is not null))),0)::integer into missing_slots from public.shift_groups g where g.schedule_id=s.id and g.is_required and exists(select 1 from public.shifts a where a.shift_group_id=g.id);
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
      label,position_id,requirement_id,template_id,slot_ordinal,is_required,shift_group_id,required_count,allow_overstaffing
    )
    select d.id,org,s.id,d.employee_id,coalesce(p.name,'General'),d.starts_at,d.ends_at,d.notes,
      d.label,d.position_id,d.requirement_id,d.template_id,d.slot_ordinal,d.is_required,d.shift_group_id,g.required_count,g.allow_overstaffing
    from public.shifts d
    join public.shift_groups g on g.id=d.shift_group_id
    left join public.positions p on p.id=d.position_id and p.organization_id=org
    where d.schedule_id=s.id;
    update public.schedules set published_revision=revision where id=s.id;
    insert into public.schedule_events(organization_id,schedule_id,revision,event_type,actor_id)
      values(org,s.id,s.revision,'schedule.published',auth.uid());
    return jsonb_build_object('id',s.id,'revision',s.revision,'unfilled',missing_slots);
  else
    raise exception 'Unknown scheduling command';
  end if;

  update public.schedules set revision=revision+1,updated_at=now()
    where id=s.id returning revision into current_version;
  insert into public.schedule_changes(organization_id,schedule_id,revision,command,payload,actor_id)
    values(org,s.id,current_version,command,payload,auth.uid());
  return jsonb_build_object('id',coalesce(result,s.id),'revision',current_version);
end $$;


create or replace function shiftly_private.save_weekly_setup_and_apply(
 org uuid,items jsonb,expected_revision integer,apply_week date
) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.schedules; req record; g public.shift_groups; day_date date;
 local_start timestamp; local_end timestamp; slot_start timestamptz; slot_end timestamptz;
 used uuid[]:='{}'; n integer; ordinal integer; added integer:=0; removed integer:=0; changed integer:=0;
begin
 perform shiftly_private.save_weekly_setup(org,items,expected_revision);
 if apply_week is null then return jsonb_build_object('applied',false); end if;
 if extract(dow from apply_week)::integer<>(select coalesce((settings->>'week_starts_on')::integer,0) from public.organizations where id=org) then raise exception 'Choose the workspace week start'; end if;
 select * into s from public.schedules where organization_id=org and week_start=apply_week for update;
 if s.id is null then return shiftly_private.schedule_command(org,'create',jsonb_build_object('week_start',apply_week),null)||jsonb_build_object('applied',true); end if;
 if s.published_revision is not null then raise exception 'This week has been published. Choose future weeks only; use the calendar to explicitly revise and publish this week'; end if;
 for req in select r.*,t.name,t.start_time,t.end_time,t.end_next_day,coalesce(r.position_id,t.position_id) resolved_position
 from public.coverage_requirements r join public.shift_templates t on t.organization_id=r.organization_id and t.id=r.template_id
 where r.organization_id=org and r.is_active order by r.weekday,t.start_time,r.id loop
   day_date:=apply_week+((req.weekday-extract(dow from apply_week)::integer+7)%7);
   local_start:=day_date+req.start_time;
   local_end:=(day_date+case when req.end_next_day then 1 else 0 end)+req.end_time;
   slot_start:=local_start at time zone s.timezone; slot_end:=local_end at time zone s.timezone;
   if slot_start at time zone s.timezone<>local_start or slot_end at time zone s.timezone<>local_end then raise exception 'A required slot falls in a skipped daylight-saving hour'; end if;
   select * into g from public.shift_groups where schedule_id=s.id and requirement_id=req.id and is_required
     and template_id=req.template_id and starts_at=slot_start and ends_at=slot_end
     and position_id is not distinct from req.resolved_position and label=req.name and notes=''
     and not(id=any(used)) order by id limit 1;
   if g.id is null then
     insert into public.shift_groups(organization_id,schedule_id,position_id,starts_at,ends_at,label,requirement_id,template_id,is_required,required_count)
     values(org,s.id,req.resolved_position,slot_start,slot_end,req.name,req.id,req.template_id,true,req.required_count) returning * into g;
   else
     update public.shift_groups set required_count=req.required_count where id=g.id;
   end if;
   used:=array_append(used,g.id);
   -- Required staffing is independent of the number of people currently assigned.
   select count(*) into n from public.shifts where shift_group_id=g.id;
   while n<req.required_count loop
     select coalesce(max(slot_ordinal),0)+1 into ordinal from public.shifts where schedule_id=s.id and requirement_id=req.id;
     insert into public.shifts(organization_id,schedule_id,shift_group_id,position_id,starts_at,ends_at,label,requirement_id,template_id,slot_ordinal,is_required,slot_kind)
     values(org,s.id,g.id,g.position_id,g.starts_at,g.ends_at,g.label,req.id,req.template_id,ordinal,true,'requirement');
     n:=n+1; added:=added+1;
   end loop;
   delete from public.shifts where id in(select id from public.shifts where shift_group_id=g.id and employee_id is null
     order by slot_ordinal desc,id limit greatest(0,n-req.required_count));
 end loop;
 -- Retired recurring groups with people become one-off shifts; no assignment is lost.
 delete from public.shifts a using public.shift_groups retired where a.shift_group_id=retired.id and retired.schedule_id=s.id
 and retired.is_required and not(retired.id=any(used)) and a.employee_id is null;
 get diagnostics removed=row_count;
 update public.shifts a set requirement_id=null,is_required=false,slot_kind='one_off'
 from public.shift_groups retired where a.shift_group_id=retired.id and retired.schedule_id=s.id and retired.is_required and not(retired.id=any(used));
 get diagnostics changed=row_count;
 update public.shift_groups set requirement_id=null,is_required=false where schedule_id=s.id and is_required and not(id=any(used));
 delete from public.shift_groups retired where schedule_id=s.id and not exists(select 1 from public.shifts a where a.shift_group_id=retired.id);
 perform shiftly_private.validate_schedule(s.id);
 update public.schedules set revision=revision+1,updated_at=now() where id=s.id returning * into s;
 insert into public.schedule_changes(organization_id,schedule_id,revision,command,payload,actor_id)
 values(org,s.id,s.revision,'weekly_setup.apply',jsonb_build_object('items',items),auth.uid());
 return jsonb_build_object('applied',true,'added',added,'removed',removed,'preserved',changed);
end $$;

commit;
