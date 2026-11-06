begin;

-- Roster identities, never auth ids, support both linked and placeholder staff.
create table public.time_off_requests (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations on delete cascade,
 employee_id uuid not null,
 start_date date not null check(isfinite(start_date)),
 end_date date not null check(end_date >= start_date and end_date <= start_date + 366 and isfinite(end_date)),
 full_day boolean not null,
 timezone text not null,
 starts_at timestamptz not null check(isfinite(starts_at)),
 ends_at timestamptz not null check(ends_at > starts_at and isfinite(ends_at)),
 notes text not null default '' check(length(notes) <= 1000),
 status text not null default 'pending' check(status in ('pending','approved','denied','cancelled')),
 created_by uuid not null references public.profiles,
 created_at timestamptz not null default now(),
 reviewed_by uuid references public.profiles,
 reviewed_at timestamptz,
 foreign key(organization_id,employee_id) references public.employees(organization_id,id)
);
create index time_off_employee_idx on public.time_off_requests(organization_id,employee_id,starts_at,ends_at);
create index time_off_pending_idx on public.time_off_requests(organization_id,created_at) where status='pending';
create index time_off_approved_idx on public.time_off_requests(organization_id,starts_at,ends_at) where status='approved';

create table public.employee_availability (
 organization_id uuid not null references public.organizations on delete cascade,
 employee_id uuid not null,
 weekday smallint not null check(weekday between 0 and 6),
 unavailable boolean not null,
 start_time time,
 end_time time,
 primary key(organization_id,employee_id,weekday),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id),
 check((unavailable and start_time is null and end_time is null) or
       (not unavailable and start_time is not null and end_time is not null and end_time > start_time and end_time < time '24:00'))
);

-- In-app notifications are committed with the decision. Emails are best effort.
-- No addresses or notes are available through this recipient-only table.
create table public.time_off_notifications (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations on delete cascade,
 request_id uuid not null references public.time_off_requests on delete cascade,
 recipient_id uuid not null references public.profiles,
 event text not null check(event in ('submitted','approved','denied')),
 created_at timestamptz not null default now(),
 email_status text not null default 'pending' check(email_status in ('pending','sending','accepted','failed','unconfigured','skipped')),
 unique(request_id,recipient_id,event)
);
create index time_off_notification_recipient_idx on public.time_off_notifications(organization_id,recipient_id,created_at);

alter table public.time_off_requests enable row level security;
alter table public.employee_availability enable row level security;
alter table public.time_off_notifications enable row level security;
create policy time_off_read on public.time_off_requests for select to authenticated using (
 public.workspace_role_for(organization_id) in ('owner','manager') or
 (public.workspace_role_for(organization_id) is not null and exists(
   select 1 from public.employees e where e.organization_id=time_off_requests.organization_id
   and e.id=time_off_requests.employee_id and e.user_id=(select auth.uid())))
);
create policy availability_read on public.employee_availability for select to authenticated using (
 public.workspace_role_for(organization_id) in ('owner','manager') or
 (public.workspace_role_for(organization_id) is not null and exists(
   select 1 from public.employees e where e.organization_id=employee_availability.organization_id
   and e.id=employee_availability.employee_id and e.user_id=(select auth.uid())))
);
create policy time_off_notifications_read on public.time_off_notifications for select to authenticated using (
 recipient_id=(select auth.uid()) and public.workspace_role_for(organization_id) is not null and
 (event<>'submitted' or public.workspace_role_for(organization_id) in ('owner','manager'))
);
revoke all on public.time_off_requests,public.employee_availability,public.time_off_notifications from public,anon,authenticated;
grant select on public.time_off_requests,public.employee_availability,public.time_off_notifications to authenticated;

-- All writes use this checked boundary; no direct writes or status escalation.
create function shiftly_private.time_off_command(org uuid,command text,payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=auth.uid(); actor_role text; employee public.employees;
 request public.time_off_requests; result uuid; tz text; item jsonb;
 first_day date; last_day date; is_full boolean; lo timestamptz; hi timestamptz;
begin
 actor_role:=public.workspace_role_for(org)::text;
 if actor is null or actor_role is null then raise exception 'Time-off permission denied'; end if;
 -- Same lock as scheduling: assignment/publication and approval serialize.
 perform 1 from public.organizations where id=org for no key update;
 actor_role:=public.workspace_role_for(org)::text;
 if actor_role is null then raise exception 'Time-off permission denied'; end if;
 if command in ('submit','manual','availability') then
   select * into employee from public.employees where organization_id=org and id=(payload->>'employee_id')::uuid;
   if employee.id is null then raise exception 'Employee unavailable'; end if;
   if command='manual' then
     if actor_role not in ('owner','manager') or employee.user_id is not null then raise exception 'Manual time off requires a placeholder employee'; end if;
   elsif employee.user_id is distinct from actor then
     raise exception 'Manage only your own requests and availability';
   end if;
   if command='availability' then
     if jsonb_typeof(payload->'days') is distinct from 'array' or jsonb_array_length(payload->'days')>7 then raise exception 'Invalid availability'; end if;
     delete from public.employee_availability where organization_id=org and employee_id=employee.id;
     for item in select value from jsonb_array_elements(payload->'days') loop
       insert into public.employee_availability(organization_id,employee_id,weekday,unavailable,start_time,end_time)
       values(org,employee.id,(item->>'weekday')::smallint,(item->>'unavailable')::boolean,
         nullif(item->>'start_time','')::time,nullif(item->>'end_time','')::time);
     end loop;
     return jsonb_build_object('id',employee.id);
   end if;
   select timezone into tz from public.organizations where id=org;
   first_day:=(payload->>'start_date')::date; last_day:=(payload->>'end_date')::date;
   is_full:=(payload->>'full_day')::boolean;
   if is_full then
     lo:=first_day::timestamp at time zone tz;
     hi:=(last_day+1)::timestamp at time zone tz;
   else
     lo:=(payload->>'starts_at')::timestamptz; hi:=(payload->>'ends_at')::timestamptz;
     if (lo at time zone tz)::date is distinct from first_day or (hi at time zone tz)::date is distinct from last_day then
       raise exception 'Partial-day dates must match the selected times';
     end if;
   end if;
   insert into public.time_off_requests(organization_id,employee_id,start_date,end_date,full_day,timezone,starts_at,ends_at,notes,status,created_by,reviewed_by,reviewed_at)
   values(org,employee.id,first_day,last_day,is_full,tz,lo,hi,coalesce(payload->>'notes',''),
     case when command='manual' then 'approved' else 'pending' end,actor,
     case when command='manual' then actor end,case when command='manual' then now() end)
   returning * into request;
   if command='submit' then
     insert into public.time_off_notifications(organization_id,request_id,recipient_id,event)
     select org,request.id,m.user_id,'submitted' from public.memberships m
     where m.organization_id=org and m.role in ('owner','manager');
   end if;
 elsif command in ('approve','deny','cancel','remove_manual') then
   select * into request from public.time_off_requests where organization_id=org and id=(payload->>'id')::uuid for update;
   if request.id is null then raise exception 'Request unavailable'; end if;
   select * into employee from public.employees where organization_id=org and id=request.employee_id;
   if command='cancel' then
     if employee.user_id is distinct from actor then raise exception 'Manage only your own requests and availability'; end if;
   elsif command='remove_manual' then
     if actor_role not in ('owner','manager') or employee.user_id is not null or request.status<>'approved' then raise exception 'Manual time off unavailable'; end if;
   elsif actor_role not in ('owner','manager') then raise exception 'Time-off permission denied';
   end if;
   if command<>'remove_manual' and request.status<>'pending' then raise exception 'Request already reviewed or cancelled. Refresh the page'; end if;
   update public.time_off_requests set status=case command when 'approve' then 'approved' when 'deny' then 'denied' else 'cancelled' end,
     reviewed_by=case when command in ('approve','deny','remove_manual') then actor else null end,
     reviewed_at=now() where id=request.id returning * into request;
   if command in ('approve','deny') and employee.user_id is not null then
     insert into public.time_off_notifications(organization_id,request_id,recipient_id,event)
       values(org,request.id,employee.user_id,request.status);
   end if;
 else raise exception 'Unknown time-off command';
 end if;
 return jsonb_build_object('id',request.id);
end $$;
create function public.time_off_command(org uuid,command text,payload jsonb) returns jsonb
language sql security invoker set search_path='' as $$select shiftly_private.time_off_command(org,command,payload)$$;
revoke all on function shiftly_private.time_off_command(uuid,text,jsonb),public.time_off_command(uuid,text,jsonb) from public,anon;
grant execute on function shiftly_private.time_off_command(uuid,text,jsonb),public.time_off_command(uuid,text,jsonb) to authenticated;

-- Prevent new hard conflicts, including direct RPC calls, copied weeks and
-- republishing. Existing shifts remain intact and can be unassigned one by one.
create function shiftly_private.check_time_off_assignment() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.employee_id is null then return new; end if;
 if tg_op='UPDATE' then
   if new.employee_id is not distinct from old.employee_id and new.starts_at=old.starts_at and new.ends_at=old.ends_at then return new; end if;
 end if;
 perform 1 from public.organizations where id=new.organization_id for no key update;
 if exists(select 1 from public.time_off_requests r where r.organization_id=new.organization_id and r.employee_id=new.employee_id
   and r.status='approved' and r.starts_at<new.ends_at and new.starts_at<r.ends_at) then
   raise exception 'Approved time off conflicts with this shift. Unassign or choose another employee';
 end if;
 return new;
end $$;
revoke all on function shiftly_private.check_time_off_assignment() from public,anon,authenticated;
create trigger time_off_assignment before insert or update on public.shifts for each row execute function shiftly_private.check_time_off_assignment();
create trigger time_off_publication before insert or update on public.published_shifts for each row execute function shiftly_private.check_time_off_assignment();

-- Email-only worker RPCs. Authenticated users cannot obtain recipient addresses.
-- Only the server's service role can claim; no automatic retries after SMTP.
create function shiftly_private.claim_time_off_email(request uuid)
returns table(id uuid,email text,event text,organization_id uuid)
language sql security definer set search_path='' as $$
 with candidates as (
   select n.id,u.email,n.event,n.organization_id,
     coalesce(u.email_confirmed_at is not null and m.user_id is not null and
       ((n.event='submitted' and m.role in ('owner','manager') and r.status='pending') or
        (n.event<>'submitted' and e.user_id=n.recipient_id)),false) eligible
   from public.time_off_notifications n
   left join auth.users u on u.id=n.recipient_id
   left join public.memberships m on m.organization_id=n.organization_id and m.user_id=n.recipient_id
   join public.time_off_requests r on r.id=n.request_id
   join public.employees e on e.organization_id=r.organization_id and e.id=r.employee_id
   where n.request_id=request and n.email_status='pending'
 ), claimed as (
   update public.time_off_notifications n set email_status=case when c.eligible then 'sending' else 'skipped' end
   from candidates c where n.id=c.id and n.email_status='pending'
   returning n.id,n.email_status
 )
 select c.id,c.email,c.event,c.organization_id from candidates c
 join claimed d on d.id=c.id where d.email_status='sending' 
$$;
create function public.claim_time_off_email(request uuid)
returns table(id uuid,email text,event text,organization_id uuid)
language sql security invoker set search_path='' as $$select * from shiftly_private.claim_time_off_email(request)$$;
create function shiftly_private.finish_time_off_email(notification uuid,result text) returns void
language sql security definer set search_path='' as $$
 update public.time_off_notifications set email_status=result where id=notification and email_status='sending' and result in ('accepted','failed','unconfigured','skipped')
$$;
create function public.finish_time_off_email(notification uuid,result text) returns void
language sql security invoker set search_path='' as $$select shiftly_private.finish_time_off_email(notification,result)$$;
revoke all on function shiftly_private.claim_time_off_email(uuid),public.claim_time_off_email(uuid),shiftly_private.finish_time_off_email(uuid,text),public.finish_time_off_email(uuid,text) from public,anon,authenticated;
do $$begin
 if exists(select 1 from pg_roles where rolname='service_role') then
   grant usage on schema shiftly_private to service_role;
   grant execute on function shiftly_private.claim_time_off_email(uuid),public.claim_time_off_email(uuid),shiftly_private.finish_time_off_email(uuid,text),public.finish_time_off_email(uuid,text) to service_role;
 end if;
end$$;
commit;
