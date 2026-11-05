begin;
-- Phase 2 is additive: no existing accounts, invitations or workspace data change.
create unique index positions_org_id_key on public.positions(organization_id,id);
create table public.schedules (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations on delete cascade,
 week_start date not null,
 timezone text not null,
 revision integer not null default 1 check(revision>0),
 published_revision integer,
 updated_at timestamptz not null default now(),
 created_by uuid not null references public.profiles,
 unique(organization_id,week_start), unique(organization_id,id)
);
create table public.shifts (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 schedule_id uuid not null,
 employee_id uuid not null,
 position_id uuid,
 starts_at timestamptz not null,
 ends_at timestamptz not null,
 notes text not null default '' check(length(notes)<=300),
 foreign key(organization_id,schedule_id) references public.schedules(organization_id,id) on delete cascade,
 foreign key(organization_id,employee_id) references public.memberships(organization_id,user_id),
 foreign key(organization_id,position_id) references public.positions(organization_id,id),
 check(isfinite(starts_at) and isfinite(ends_at) and ends_at>starts_at and ends_at-starts_at<=interval '26 hours')
);
create index shifts_schedule_idx on public.shifts(organization_id,schedule_id);
create index shifts_org_time_idx on public.shifts(organization_id,starts_at,ends_at);
create index shifts_employee_time_idx on public.shifts(organization_id,employee_id,starts_at,ends_at);
create table public.published_schedules (
 id uuid primary key,
 organization_id uuid not null references public.organizations on delete cascade,
 week_start date not null,
 timezone text not null,
 revision integer not null,
 published_at timestamptz not null default now(),
 published_by uuid not null references public.profiles,
 unique(organization_id,week_start), unique(organization_id,id),
 foreign key(organization_id,id) references public.schedules(organization_id,id) on delete cascade
);
create table public.published_shifts (
 id uuid primary key,
 organization_id uuid not null,
 schedule_id uuid not null,
 employee_id uuid not null references public.profiles,
 position_name text not null,
 starts_at timestamptz not null,
 ends_at timestamptz not null,
 notes text not null,
 foreign key(organization_id,schedule_id) references public.published_schedules(organization_id,id) on delete cascade,
 check(isfinite(starts_at) and isfinite(ends_at) and ends_at>starts_at)
);
create index published_shifts_schedule_idx on public.published_shifts(organization_id,schedule_id);
create index published_shifts_org_time_idx on public.published_shifts(organization_id,starts_at,ends_at);
create index published_shifts_employee_time_idx on public.published_shifts(organization_id,employee_id,starts_at,ends_at);
create table public.shift_templates (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations on delete cascade,
 name text not null check(length(trim(name)) between 1 and 60),
 start_time time not null,
 end_time time not null,
 end_next_day boolean not null default false,
 position_id uuid,
 revision integer not null default 1,
 unique(organization_id,name),
 foreign key(organization_id,position_id) references public.positions(organization_id,id),
 check(start_time<time '24:00' and end_time<time '24:00'),
 check((not end_next_day and end_time>start_time) or (end_next_day and end_time<=start_time))
);
create table public.schedule_settings (
 organization_id uuid primary key references public.organizations on delete cascade,
 weekly_hours_warning numeric not null default 40 check(weekly_hours_warning between 1 and 168),
 revision integer not null default 1
);
-- Transactional event boundary for a future notification worker. Nothing sends mail.
create table public.schedule_events (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations on delete cascade,
 schedule_id uuid not null,
 revision integer not null,
 event_type text not null check(event_type='schedule.published'),
 created_at timestamptz not null default now(),
 actor_id uuid not null references public.profiles,
 unique(schedule_id,revision),
 foreign key(organization_id,schedule_id) references public.schedules(organization_id,id) on delete cascade
);
create index schedule_events_org_idx on public.schedule_events(organization_id,created_at);

alter table public.schedules enable row level security;
alter table public.shifts enable row level security;
alter table public.published_schedules enable row level security;
alter table public.published_shifts enable row level security;
alter table public.shift_templates enable row level security;
alter table public.schedule_settings enable row level security;
alter table public.schedule_events enable row level security;
create policy schedules_manager_read on public.schedules for select to authenticated using(public.workspace_role_for(organization_id) in ('owner','manager'));
create policy shifts_manager_read on public.shifts for select to authenticated using(public.workspace_role_for(organization_id) in ('owner','manager'));
create policy published_schedules_member_read on public.published_schedules for select to authenticated using(public.workspace_role_for(organization_id) is not null);
create policy published_shifts_member_read on public.published_shifts for select to authenticated using(public.workspace_role_for(organization_id) is not null);
create policy templates_manager_read on public.shift_templates for select to authenticated using(public.workspace_role_for(organization_id) in ('owner','manager'));
create policy schedule_settings_manager_read on public.schedule_settings for select to authenticated using(public.workspace_role_for(organization_id) in ('owner','manager'));
create policy schedule_events_manager_read on public.schedule_events for select to authenticated using(public.workspace_role_for(organization_id) in ('owner','manager'));
revoke all on public.schedules,public.shifts,public.published_schedules,public.published_shifts,public.shift_templates,public.schedule_settings,public.schedule_events from public,anon,authenticated;
grant select on public.schedules,public.shifts,public.published_schedules,public.published_shifts,public.shift_templates,public.schedule_settings,public.schedule_events to authenticated;

create schema if not exists shiftly_private;
revoke all on schema shiftly_private from public,anon;
grant usage on schema shiftly_private to authenticated;
-- Central validation hook: future approved-time-off checks belong here.
create function shiftly_private.validate_schedule(target uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare s public.schedules;
begin
 select * into strict s from public.schedules where id=target;
 if exists(select 1 from public.shifts d where d.schedule_id=target and (
   (d.starts_at at time zone s.timezone)::date<s.week_start or
   (d.starts_at at time zone s.timezone)::date>=s.week_start+7 or
   (d.ends_at at time zone s.timezone)-(d.starts_at at time zone s.timezone)>interval '24 hours' or
   (d.ends_at at time zone s.timezone)::date>(d.starts_at at time zone s.timezone)::date+1
 )) then raise exception 'Shift must start in this week and end within the next day (maximum 24 local hours)'; end if;
 if exists(select 1 from public.shifts a join public.shifts b on
   a.organization_id=b.organization_id and a.employee_id=b.employee_id and a.id<>b.id
   and a.starts_at<b.ends_at and b.starts_at<a.ends_at where a.schedule_id=target)
 or exists(select 1 from public.shifts a join public.published_shifts b on
   a.organization_id=b.organization_id and a.employee_id=b.employee_id and a.schedule_id<>b.schedule_id
   and a.starts_at<b.ends_at and b.starts_at<a.ends_at where a.schedule_id=target)
 then raise exception 'Employee has overlapping shifts. Check this and adjacent weeks'; end if;
 if exists(select 1 from public.shifts a left join public.memberships m on
   m.organization_id=a.organization_id and m.user_id=a.employee_id where a.schedule_id=target and m.user_id is null)
 then raise exception 'Assigned employee is no longer a member'; end if;
end $$;
revoke all on function shiftly_private.validate_schedule(uuid) from public,anon,authenticated;

-- All mutations go through this atomic boundary. A per-organization lock protects
-- cross-week overlap checks, publication, and compare-and-swap revisions together.
create function shiftly_private.schedule_command(org uuid, command text, payload jsonb, expected_revision integer default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.schedules; target uuid; result uuid; current_version integer; item jsonb;
 local_week date; tz text; affected_rows integer;
begin
 if auth.uid() is null or coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Schedule permission denied'; end if;
 perform 1 from public.organizations where id=org for no key update;
 if coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Schedule permission denied'; end if;
 if command='create' then
   local_week:=(payload->>'week_start')::date;
   select timezone into tz from public.organizations where id=org;
   if local_week is null or extract(dow from local_week)::integer<>(select coalesce((settings->>'week_starts_on')::integer,0) from public.organizations where id=org)
   then raise exception 'Choose the workspace week start'; end if;
   if exists(select 1 from public.schedules where organization_id=org and week_start=local_week) then raise exception 'A draft already exists. Refresh before editing'; end if;
   insert into public.schedules(organization_id,week_start,timezone,created_by) values(org,local_week,tz,auth.uid()) returning * into s;
   -- Seed hotel-friendly templates once per workspace without touching existing data.
   insert into public.schedule_settings(organization_id) values(org) on conflict do nothing;
   get diagnostics affected_rows=row_count;
   if affected_rows>0 then
     insert into public.shift_templates(organization_id,name,start_time,end_time,end_next_day) values
     (org,'Morning','07:00','15:00',false),(org,'Evening','15:00','23:00',false),(org,'Overnight','23:00','07:00',true)
     on conflict do nothing;
   end if;
   if jsonb_typeof(coalesce(payload->'shifts','[]'::jsonb))<>'array' or jsonb_array_length(coalesce(payload->'shifts','[]'::jsonb))>300 then raise exception 'Invalid copied shifts'; end if;
   for item in select value from jsonb_array_elements(coalesce(payload->'shifts','[]'::jsonb)) loop
     insert into public.shifts(organization_id,schedule_id,employee_id,position_id,starts_at,ends_at,notes)
     values(org,s.id,(item->>'employee_id')::uuid,nullif(item->>'position_id','')::uuid,(item->>'starts_at')::timestamptz,(item->>'ends_at')::timestamptz,coalesce(item->>'notes',''));
   end loop;
   perform shiftly_private.validate_schedule(s.id);
   return jsonb_build_object('id',s.id,'revision',s.revision);
 elsif command in ('template_save','template_delete') then
   target:=nullif(payload->>'id','')::uuid;
   if target is not null then
     select revision into current_version from public.shift_templates where organization_id=org and id=target for update;
     if current_version is null then raise exception 'Template unavailable'; end if;
     if expected_revision is distinct from current_version then raise exception 'Stale revision. Refresh before editing'; end if;
   end if;
   if command='template_delete' then
     delete from public.shift_templates where organization_id=org and id=target;
     if not found then raise exception 'Template unavailable'; end if;
     return '{}'::jsonb;
   elsif target is null then
     insert into public.shift_templates(organization_id,name,start_time,end_time,end_next_day,position_id)
     values(org,trim(payload->>'name'),(payload->>'start_time')::time,(payload->>'end_time')::time,(payload->>'end_next_day')::boolean,nullif(payload->>'position_id','')::uuid) returning id into result;
   else
     update public.shift_templates set name=trim(payload->>'name'),start_time=(payload->>'start_time')::time,end_time=(payload->>'end_time')::time,
       end_next_day=(payload->>'end_next_day')::boolean,position_id=nullif(payload->>'position_id','')::uuid,revision=revision+1 where id=target returning id into result;
   end if;
   return jsonb_build_object('id',result);
 elsif command='settings' then
   select revision into current_version from public.schedule_settings where organization_id=org for update;
   if expected_revision is distinct from current_version then raise exception 'Stale revision. Refresh before editing'; end if;
   if current_version is null then raise exception 'Create a draft before configuring weekly hours'; end if;
   update public.schedule_settings set weekly_hours_warning=(payload->>'weekly_hours_warning')::numeric,revision=revision+1 where organization_id=org;
   return '{}'::jsonb;
 elsif command='position' then
   insert into public.positions(organization_id,name) values(org,trim(payload->>'name')) returning id into result;
   return jsonb_build_object('id',result);
 end if;
 select * into s from public.schedules where organization_id=org and id=(payload->>'schedule_id')::uuid for update;
 if s.id is null then raise exception 'Schedule unavailable'; end if;
 if expected_revision is distinct from s.revision then raise exception 'Stale revision. Refresh before editing'; end if;
 if command='save' then
   target:=nullif(payload->>'id','')::uuid;
   if target is null then
     if (select count(*) from public.shifts where schedule_id=s.id)>=300 then raise exception 'Weekly shift limit reached'; end if;
     insert into public.shifts(organization_id,schedule_id,employee_id,position_id,starts_at,ends_at,notes)
     values(org,s.id,(payload->>'employee_id')::uuid,nullif(payload->>'position_id','')::uuid,(payload->>'starts_at')::timestamptz,(payload->>'ends_at')::timestamptz,coalesce(payload->>'notes','')) returning id into result;
   else
     update public.shifts set employee_id=(payload->>'employee_id')::uuid,position_id=nullif(payload->>'position_id','')::uuid,
       starts_at=(payload->>'starts_at')::timestamptz,ends_at=(payload->>'ends_at')::timestamptz,notes=coalesce(payload->>'notes','')
       where id=target and organization_id=org and schedule_id=s.id returning id into result;
     if result is null then raise exception 'Shift unavailable'; end if;
   end if;
   perform shiftly_private.validate_schedule(s.id);
 elsif command='delete' then
   delete from public.shifts where id=(payload->>'id')::uuid and organization_id=org and schedule_id=s.id;
   if not found then raise exception 'Shift unavailable'; end if;
 elsif command='publish' then
   if s.published_revision=s.revision then raise exception 'No unpublished changes'; end if;
   perform shiftly_private.validate_schedule(s.id);
   insert into public.published_schedules(id,organization_id,week_start,timezone,revision,published_by)
   values(s.id,org,s.week_start,s.timezone,s.revision,auth.uid())
   on conflict(id) do update set revision=excluded.revision,published_at=now(),published_by=excluded.published_by;
   delete from public.published_shifts where schedule_id=s.id;
   insert into public.published_shifts(id,organization_id,schedule_id,employee_id,position_name,starts_at,ends_at,notes)
   select d.id,org,s.id,d.employee_id,coalesce(p.name,'General'),d.starts_at,d.ends_at,d.notes from public.shifts d
     left join public.positions p on p.id=d.position_id and p.organization_id=org where d.schedule_id=s.id;
   update public.schedules set published_revision=revision where id=s.id;
   insert into public.schedule_events(organization_id,schedule_id,revision,event_type,actor_id) values(org,s.id,s.revision,'schedule.published',auth.uid());
   return jsonb_build_object('id',s.id,'revision',s.revision);
 else raise exception 'Unknown scheduling command';
 end if;
 update public.schedules set revision=revision+1,updated_at=now() where id=s.id returning revision into current_version;
 return jsonb_build_object('id',coalesce(result,s.id),'revision',current_version);
end $$;
create function public.schedule_command(org uuid, command text, payload jsonb, expected_revision integer default null) returns jsonb
language sql security invoker set search_path='' as $$ select shiftly_private.schedule_command(org,command,payload,expected_revision) $$;
revoke all on function shiftly_private.schedule_command(uuid,text,jsonb,integer),public.schedule_command(uuid,text,jsonb,integer) from public,anon;
grant execute on function shiftly_private.schedule_command(uuid,text,jsonb,integer),public.schedule_command(uuid,text,jsonb,integer) to authenticated;

commit;
