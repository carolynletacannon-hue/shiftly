begin;
-- Preserve unassigned slots in future publications so employees can volunteer.
alter table public.published_shifts alter column employee_id drop not null;
do $migration$
declare definition text;
begin
 select pg_get_functiondef('shiftly_private.schedule_command(uuid,text,jsonb,integer)'::regprocedure) into definition;
 if position('where d.schedule_id=s.id and d.employee_id is not null' in definition)=0 then raise exception 'Publication implementation changed; review Phase 4 migration'; end if;
 execute replace(definition,'where d.schedule_id=s.id and d.employee_id is not null','where d.schedule_id=s.id');
end $migration$;
-- All commands share the organization row lock with schedule publication.
create table public.shift_coverage_policies (
 organization_id uuid primary key references public.organizations on delete cascade,
 require_manager boolean not null default true,
 revision integer not null default 1
);
create table public.shift_requests (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations,
 kind text not null check(kind in ('coverage','swap','open','manual')),
 shift_id uuid not null, other_shift_id uuid,
 original_employee uuid, replacement_employee uuid,
 requester uuid not null references public.profiles,
 status text not null default 'open' check(status in ('open','pending','completed','denied','cancelled','declined')),
 source_snapshot jsonb not null, other_snapshot jsonb,
 source_revision integer not null, other_revision integer,
 source_timezone text not null, other_timezone text,
 policy_revision integer not null, manager_required boolean not null,
 accepted_by uuid references public.profiles, accepted_at timestamptz,
 approved_by uuid references public.profiles, completed_at timestamptz,
 created_at timestamptz not null default now(),
 foreign key(organization_id,original_employee) references public.employees(organization_id,id),
 foreign key(organization_id,replacement_employee) references public.employees(organization_id,id)
);
create unique index shift_requests_one_offer on public.shift_requests(organization_id,shift_id) where status in ('open','pending');
create index shift_requests_org_status on public.shift_requests(organization_id,status,created_at);
create table public.shift_request_responses (
 request_id uuid not null references public.shift_requests, organization_id uuid not null references public.organizations,
 employee_id uuid not null, response text not null check(response in ('accepted','declined')),
 created_at timestamptz not null default now(), primary key(request_id,employee_id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id)
);
create table public.shift_notifications (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations,
 user_id uuid not null references public.profiles, request_id uuid not null references public.shift_requests,
 message text not null, created_at timestamptz not null default now()
);
create index shift_notifications_inbox on public.shift_notifications(organization_id,user_id,created_at);
alter table public.shift_coverage_policies enable row level security;
revoke all on public.shift_coverage_policies from public,anon,authenticated;
grant select on public.shift_coverage_policies to authenticated;
alter table public.shift_requests enable row level security;
revoke all on public.shift_requests from public,anon,authenticated;
grant select on public.shift_requests to authenticated;
alter table public.shift_request_responses enable row level security;
revoke all on public.shift_request_responses from public,anon,authenticated;
grant select on public.shift_request_responses to authenticated;
alter table public.shift_notifications enable row level security;
revoke all on public.shift_notifications from public,anon,authenticated;
grant select on public.shift_notifications to authenticated;
create policy policy_read on public.shift_coverage_policies for select to authenticated using(public.workspace_role_for(organization_id) is not null);
create policy requests_read on public.shift_requests for select to authenticated using(public.workspace_role_for(organization_id) is not null);
create policy responses_read on public.shift_request_responses for select to authenticated using(public.workspace_role_for(organization_id) in ('owner','manager') or employee_id in (select id from public.employees where user_id=(select auth.uid()) and organization_id=shift_request_responses.organization_id));
create policy notifications_read on public.shift_notifications for select to authenticated using(user_id=(select auth.uid()) and public.workspace_role_for(organization_id) is not null);

-- Internal validation works on UTC instants; availability uses publication timezone.
create function shiftly_private.transfer_conflict(org uuid,employee uuid,starts timestamptz,ends timestamptz,excluded uuid[]) returns text
language sql stable set search_path='' as $$
 select case
 when not exists(select 1 from public.employees e join public.memberships m on m.organization_id=e.organization_id and m.user_id=e.user_id where e.organization_id=org and e.id=employee) then 'Employee is not eligible'
 when exists(select 1 from public.published_shifts s where s.organization_id=org and s.employee_id=employee and not(s.id=any(excluded)) and s.starts_at<ends and starts<s.ends_at) then 'Overlapping published shift'
 when exists(select 1 from public.shifts s where s.organization_id=org and s.employee_id=employee and not(s.id=any(excluded)) and s.starts_at<ends and starts<s.ends_at) then 'Overlapping draft shift'
 when exists(select 1 from public.time_off_requests t where t.organization_id=org and t.employee_id=employee and t.status='approved' and t.starts_at<ends and starts<t.ends_at) then 'Approved time off'
 else null end
$$;
revoke all on function shiftly_private.transfer_conflict(uuid,uuid,timestamptz,timestamptz,uuid[]) from public,anon,authenticated;

create function shiftly_private.shift_request_command(org uuid,command text,payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=auth.uid(); manager boolean; me uuid; p public.shift_coverage_policies;
 r public.shift_requests; a public.published_shifts; b public.published_shifts;
 source_rev integer; other_rev integer; target uuid; failure text; sid uuid;
 draft public.shifts; new_revision integer;
begin
 if command not in ('policy','coverage','swap','open','manual','cancel','deny','accept','decline','approve') or command is null then raise exception 'Unknown request command'; end if;
 if actor is null or public.workspace_role_for(org) is null then raise exception 'Permission denied'; end if;
 perform 1 from public.organizations where id=org for no key update;
 if public.workspace_role_for(org) is null then raise exception 'Permission denied'; end if;
 manager:=public.workspace_role_for(org) in ('owner','manager');
 select id into me from public.employees where organization_id=org and user_id=actor;
 insert into public.shift_coverage_policies(organization_id) values(org) on conflict do nothing;
 select * into strict p from public.shift_coverage_policies where organization_id=org;
 if command='policy' then
   if not manager then raise exception 'Permission denied'; end if;
   if p.revision is distinct from (payload->>'revision')::integer then raise exception 'Settings changed. Refresh'; end if;
   update public.shift_coverage_policies set require_manager=(payload->>'require_manager')::boolean,revision=revision+1 where organization_id=org;
   return '{}'::jsonb;
 end if;
 if command in ('coverage','swap','open','manual') then
   select * into a from public.published_shifts where id=(payload->>'shift_id')::uuid and organization_id=org;
   if a.id is null or a.starts_at<=now() then raise exception 'Upcoming published shift required'; end if;
   if command in ('coverage','swap') and a.employee_id is distinct from me then raise exception 'You do not own this shift'; end if;
   if command in ('open','manual') and ((not manager and not(command='open' and a.employee_id is null)) or exists(select 1 from public.employees where organization_id=org and id=a.employee_id and user_id is not null)) then raise exception 'Manager may reassign placeholder shifts only'; end if;
   select revision into source_rev from public.published_schedules where id=a.schedule_id;
   if command='swap' then
     select * into b from public.published_shifts where id=(payload->>'other_shift_id')::uuid and organization_id=org;
     if b.id is null or b.starts_at<=now() or b.employee_id=me then raise exception 'Choose a coworker upcoming shift'; end if;
     target:=b.employee_id;
     select revision into other_rev from public.published_schedules where id=b.schedule_id;
     failure:=shiftly_private.transfer_conflict(org,target,a.starts_at,a.ends_at,array[a.id,b.id]);
     if failure is null then failure:=shiftly_private.transfer_conflict(org,me,b.starts_at,b.ends_at,array[a.id,b.id]); end if;
     if failure is not null then raise exception '%',failure; end if;
   elsif command='manual' then target:=(payload->>'employee_id')::uuid;
   end if;
   insert into public.shift_requests(organization_id,kind,shift_id,other_shift_id,original_employee,replacement_employee,requester,source_snapshot,other_snapshot,source_revision,other_revision,source_timezone,other_timezone,policy_revision,manager_required)
   values(org,command,a.id,b.id,a.employee_id,target,actor,to_jsonb(a),case when b.id is not null then to_jsonb(b) end,source_rev,other_rev,(select timezone from public.published_schedules where id=a.schedule_id),(select timezone from public.published_schedules where id=b.schedule_id),p.revision,p.require_manager or command='manual') returning * into r;
   if command='open' and not manager then command:='accept'; end if;
   if command='manual' then
     update public.shift_requests set status='pending',accepted_by=actor,accepted_at=now() where id=r.id returning * into r;
     command:='approve';
   end if;
 else
   select * into r from public.shift_requests where id=(payload->>'request_id')::uuid and organization_id=org for update;
   if r.id is null or r.status not in ('open','pending') then raise exception 'Request is no longer pending'; end if;
 end if;
 if command='cancel' then
   if r.requester<>actor then raise exception 'Permission denied'; end if;
   update public.shift_requests set status='cancelled' where id=r.id returning * into r;
 elsif command='deny' then
   if not manager then raise exception 'Permission denied'; end if;
   update public.shift_requests set status='denied',approved_by=actor where id=r.id returning * into r;
 elsif command in ('accept','decline') then
   if me is null or me=r.original_employee or (r.kind='swap' and me is distinct from r.replacement_employee) then raise exception 'Permission denied'; end if;
   if r.status<>'open' then raise exception 'A volunteer has already accepted'; end if;
   if command='decline' then
     insert into public.shift_request_responses values(r.id,org,me,'declined',now()) on conflict(request_id,employee_id) do update set response='declined',created_at=now();
     if r.kind='swap' then update public.shift_requests set status='declined' where id=r.id returning * into r; end if;
   else
     select * into a from public.published_shifts where id=r.shift_id and organization_id=org;
     failure:=shiftly_private.transfer_conflict(org,me,a.starts_at,a.ends_at,array_remove(array[r.shift_id,r.other_shift_id],null));
     if a.id is null or a.starts_at<=now() then raise exception 'Shift unavailable'; end if;
     if failure is not null then raise exception '%',failure; end if;
     update public.shift_requests set status='pending',replacement_employee=me,accepted_by=actor,accepted_at=now() where id=r.id returning * into r;
     insert into public.shift_request_responses values(r.id,org,me,'accepted',now()) on conflict(request_id,employee_id) do update set response='accepted',created_at=now();
   end if;
 end if;
 if command='approve' or (command='accept' and not p.require_manager and not r.manager_required and p.revision=r.policy_revision) then
   if command='approve' and not manager then raise exception 'Permission denied'; end if;
   if r.status<>'pending' or r.accepted_by is null then raise exception 'Employee acceptance required'; end if;
   select * into a from public.published_shifts where id=r.shift_id and organization_id=org;
   select * into b from public.published_shifts where id=r.other_shift_id and organization_id=org;
   if a.id is null or a.starts_at<=now() or to_jsonb(a) is distinct from r.source_snapshot or (select revision from public.published_schedules where id=a.schedule_id)<>r.source_revision then raise exception 'Published schedule changed. Create a new request'; end if;
   if r.kind='swap' and (b.id is null or b.starts_at<=now() or to_jsonb(b) is distinct from r.other_snapshot or (select revision from public.published_schedules where id=b.schedule_id)<>r.other_revision) then raise exception 'Published schedule changed. Create a new request'; end if;
   failure:=shiftly_private.transfer_conflict(org,r.replacement_employee,a.starts_at,a.ends_at,array_remove(array[a.id,b.id],null));
   if failure is null and r.kind='swap' then failure:=shiftly_private.transfer_conflict(org,r.original_employee,b.starts_at,b.ends_at,array[a.id,b.id]); end if;
   if failure is not null then raise exception '%',failure; end if;
   -- Refuse to overwrite a manager edit on either affected draft row.
   for sid in select x from unnest(array_remove(array[a.id,b.id],null)) x loop
     select * into draft from public.shifts where id=sid;
     if draft.id is null or draft.employee_id is distinct from (case when sid=a.id then a.employee_id else b.employee_id end)
       or draft.starts_at is distinct from (case when sid=a.id then a.starts_at else b.starts_at end)
       or draft.ends_at is distinct from (case when sid=a.id then a.ends_at else b.ends_at end) then raise exception 'Affected draft changed. Resolve with manager'; end if;
   end loop;
   update public.published_shifts set employee_id=r.replacement_employee where id=a.id;
   update public.shifts set employee_id=r.replacement_employee where id=a.id;
   if r.kind='swap' then
     update public.published_shifts set employee_id=r.original_employee where id=b.id;
     update public.shifts set employee_id=r.original_employee where id=b.id;
   end if;
   for sid in select distinct x from unnest(array_remove(array[a.schedule_id,b.schedule_id],null)) x loop
     update public.schedules set published_revision=case when published_revision=revision then revision+1 else published_revision end,
       revision=revision+1,updated_at=now() where id=sid returning revision into new_revision;
     update public.published_schedules set revision=new_revision,published_at=now(),published_by=actor where id=sid;
     insert into public.schedule_events(organization_id,schedule_id,revision,event_type,actor_id) values(org,sid,new_revision,'schedule.published',actor);
   end loop;
   update public.shift_requests set status='completed',approved_by=case when command='approve' then actor end,completed_at=now(),manager_required=(command='approve') where id=r.id returning * into r;
 end if;
 insert into public.shift_notifications(organization_id,user_id,request_id,message)
 select org,m.user_id,r.id,'Shift request: '||r.kind||' · '||r.status from public.memberships m
 where m.organization_id=org and (m.role in ('owner','manager') or m.user_id=r.requester or m.user_id=r.accepted_by or (r.status='open' and (r.kind in ('coverage','open') or exists(select 1 from public.employees e where e.organization_id=org and e.id=r.replacement_employee and e.user_id=m.user_id))));
 return to_jsonb(r);
end $$;
create function public.shift_request_command(org uuid,command text,payload jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select shiftly_private.shift_request_command(org,command,payload) $$;
revoke all on function shiftly_private.shift_request_command(uuid,text,jsonb),public.shift_request_command(uuid,text,jsonb) from public,anon;
grant execute on function shiftly_private.shift_request_command(uuid,text,jsonb),public.shift_request_command(uuid,text,jsonb) to authenticated;

create function shiftly_private.transfer_preview(org uuid,shift_id uuid,employee_id uuid,other_shift_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.published_shifts; b public.published_shifts; tz text; week_start timestamptz; week_end timestamptz; failure text; hours numeric; warning boolean; manager boolean;
begin
 if auth.uid() is null or public.workspace_role_for(org) is null then raise exception 'Permission denied'; end if;
 manager:=public.workspace_role_for(org) in ('owner','manager');
 if not manager and not exists(select 1 from public.employees e where e.organization_id=org and e.id=employee_id and e.user_id=auth.uid()) then raise exception 'Permission denied'; end if;
 select * into a from public.published_shifts s where s.organization_id=org and s.id=shift_id;
 select * into b from public.published_shifts s where s.organization_id=org and s.id=other_shift_id;
 if a.id is null or a.starts_at<=now() then return jsonb_build_object('eligible',false,'conflict','Shift unavailable'); end if;
 select timezone into tz from public.published_schedules where id=a.schedule_id;
 -- Explicit conversion avoids depending on the database session timezone.
 week_start:=((a.starts_at at time zone tz)::date-((extract(dow from a.starts_at at time zone tz)::integer-(select coalesce((settings->>'week_starts_on')::integer,0) from public.organizations where id=org)+7)%7))::timestamp at time zone tz;
 week_end:=((week_start at time zone tz)+interval '7 days') at time zone tz;
 failure:=shiftly_private.transfer_conflict(org,employee_id,a.starts_at,a.ends_at,array_remove(array[a.id,b.id],null));
 if failure is null and b.id is not null then failure:=shiftly_private.transfer_conflict(org,a.employee_id,b.starts_at,b.ends_at,array[a.id,b.id]); end if;
 select coalesce(sum(extract(epoch from (least(s.ends_at,week_end)-greatest(s.starts_at,week_start)))/3600),0) into hours from public.published_shifts s where s.organization_id=org and s.employee_id=transfer_preview.employee_id and s.id<>a.id and (b.id is null or s.id<>b.id) and s.starts_at<week_end and s.ends_at>week_start;
 hours:=hours+extract(epoch from (least(a.ends_at,week_end)-greatest(a.starts_at,week_start)))/3600;
 warning:=exists(
  select 1 from generate_series((a.starts_at at time zone tz)::date::timestamp,((a.ends_at-interval '1 microsecond') at time zone tz)::date::timestamp,interval '1 day') day
  join public.employee_availability v on v.organization_id=org and v.employee_id=transfer_preview.employee_id and v.weekday=extract(dow from day)
  where v.unavailable or (greatest(a.starts_at,day at time zone tz) at time zone tz)::time<v.start_time
    or ((least(a.ends_at,(day+interval '1 day') at time zone tz)-interval '1 microsecond') at time zone tz)::time>=v.end_time
 );
 return jsonb_build_object('eligible',failure is null,'conflict',case when manager then failure else case when failure is not null then 'Scheduling conflict' end end,'weekly_hours',hours,'availability_warning',warning,'hours_warning',hours>coalesce((select weekly_hours_warning from public.schedule_settings where organization_id=org),40));
end $$;
create function public.transfer_preview(org uuid,shift_id uuid,employee_id uuid,other_shift_id uuid default null) returns jsonb
language sql security invoker set search_path='' as $$select shiftly_private.transfer_preview(org,shift_id,employee_id,other_shift_id)$$;
revoke all on function shiftly_private.transfer_preview(uuid,uuid,uuid,uuid),public.transfer_preview(uuid,uuid,uuid,uuid) from public,anon;
grant execute on function shiftly_private.transfer_preview(uuid,uuid,uuid,uuid),public.transfer_preview(uuid,uuid,uuid,uuid) to authenticated;

-- Durable email work is separate from schedule transactions. Only service_role
-- can claim delivery work or resolve auth emails; members cannot read addresses.
create table public.shift_email_deliveries (
 id uuid primary key references public.shift_notifications, organization_id uuid not null references public.organizations,
 user_id uuid not null references public.profiles, message text not null,
 attempts integer not null default 0, claimed_until timestamptz, sent_at timestamptz
);
alter table public.shift_email_deliveries enable row level security;
revoke all on public.shift_email_deliveries from public,anon,authenticated;
create function shiftly_private.queue_shift_email() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.shift_email_deliveries(id,organization_id,user_id,message) values(new.id,new.organization_id,new.user_id,new.message);
 return new;
end $$;
revoke all on function shiftly_private.queue_shift_email() from public,anon,authenticated;
create trigger queue_shift_email after insert on public.shift_notifications for each row execute function shiftly_private.queue_shift_email();
create function public.claim_shift_emails() returns setof public.shift_email_deliveries language sql security invoker set search_path='' as $$
 update public.shift_email_deliveries set attempts=attempts+1,claimed_until=now()+interval '5 minutes'
 where id in (select id from public.shift_email_deliveries where sent_at is null and attempts<10 and (claimed_until is null or claimed_until<now()) order by id limit 10 for update skip locked)
 returning *
$$;
revoke all on function public.claim_shift_emails() from public,anon,authenticated;
do $$begin
 if exists(select 1 from pg_roles where rolname='service_role') then
  grant select,update on public.shift_email_deliveries to service_role;
  grant execute on function public.claim_shift_emails() to service_role;
 end if;
end $$;
commit;
