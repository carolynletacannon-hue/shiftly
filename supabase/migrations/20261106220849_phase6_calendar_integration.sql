begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local timezone='UTC';
-- Serialize the backfill with all existing scheduling and lifecycle commands.
lock table public.organizations in exclusive mode;
lock table public.published_shifts in share row exclusive mode;

-- No raw secrets, general roster grants, or browser-accessible event history.
create table shiftly_private.calendar_subscriptions (
 organization_id uuid not null,
 employee_id uuid not null,
 user_id uuid not null references public.profiles on delete cascade,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 expires_at timestamptz,
 request_window timestamptz not null default now(),
 request_count integer not null default 0,
 primary key(organization_id,employee_id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete cascade
);
create index calendar_subscriptions_user_idx on shiftly_private.calendar_subscriptions(user_id);
create table shiftly_private.calendar_events (
 organization_id uuid not null references public.organizations on delete cascade,
 employee_id uuid not null,
 shift_id uuid not null,
 details jsonb not null,
 cancelled boolean not null default false,
 sequence integer not null default 0 check(sequence>=0),
 updated_at timestamptz not null default now(),
 primary key(organization_id,employee_id,shift_id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id)
);
-- Fixed-size buckets prevent attacker-controlled storage growth. No IPs retained.
create table shiftly_private.calendar_request_buckets (
 bucket integer primary key check(bucket between 0 and 255),
 window_start timestamptz not null,
 requests integer not null
);
alter table shiftly_private.calendar_subscriptions enable row level security;
alter table shiftly_private.calendar_events enable row level security;
alter table shiftly_private.calendar_request_buckets enable row level security;
revoke all on shiftly_private.calendar_subscriptions,shiftly_private.calendar_events,shiftly_private.calendar_request_buckets from public,anon,authenticated;

-- One event per published assignment and employee. Deferred triggers observe the
-- final transaction state, so delete/reinsert publication does not cause churn.
create function shiftly_private.sync_calendar_event(org uuid,employee uuid,shift uuid) returns void
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare snapshot jsonb;
begin
 if employee is null then return; end if;
 select jsonb_build_object('starts_at',s.starts_at,'ends_at',s.ends_at,
   'label',s.label,'position',s.position_name,'notes',s.notes,'business',o.name)
 into snapshot from public.published_shifts s
 join public.organizations o on o.id=s.organization_id
 where s.organization_id=org and s.employee_id=employee and s.id=shift;
 if snapshot is null then
   update shiftly_private.calendar_events set cancelled=true,sequence=sequence+1,updated_at=now()
   where organization_id=org and employee_id=employee and shift_id=shift and not cancelled;
 else
   insert into shiftly_private.calendar_events as e(organization_id,employee_id,shift_id,details)
   values(org,employee,shift,snapshot)
   on conflict(organization_id,employee_id,shift_id) do update
   set details=excluded.details,cancelled=false,sequence=e.sequence+1,updated_at=now()
   where e.details is distinct from excluded.details or e.cancelled;
 end if;
end $$;
create function shiftly_private.track_calendar_publication() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'INSERT' then perform shiftly_private.sync_calendar_event(old.organization_id,old.employee_id,old.id); end if;
 if tg_op<>'DELETE' then perform shiftly_private.sync_calendar_event(new.organization_id,new.employee_id,new.id); end if;
 return null;
end $$;
create constraint trigger calendar_publication after insert or update or delete on public.published_shifts
 deferrable initially deferred for each row execute function shiftly_private.track_calendar_publication();
-- Additive historical backfill from published snapshots ONLY.
insert into shiftly_private.calendar_events(organization_id,employee_id,shift_id,details,updated_at)
select s.organization_id,s.employee_id,s.id,
 jsonb_build_object('starts_at',s.starts_at,'ends_at',s.ends_at,'label',s.label,
 'position',s.position_name,'notes',s.notes,'business',o.name),p.published_at
from public.published_shifts s join public.organizations o on o.id=s.organization_id
join public.published_schedules p on p.organization_id=s.organization_id and p.id=s.schedule_id
where s.employee_id is not null;

-- Lifecycle changes permanently invalidate existing URLs, even after reconnect.
create function shiftly_private.revoke_calendar_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='memberships' then
   if tg_op='DELETE' then
     delete from shiftly_private.calendar_subscriptions where organization_id=old.organization_id and user_id=old.user_id;
   elsif new.organization_id is distinct from old.organization_id or new.user_id is distinct from old.user_id then
     delete from shiftly_private.calendar_subscriptions where organization_id=old.organization_id and user_id=old.user_id;
   end if;
 elsif tg_op='DELETE' then
   delete from shiftly_private.calendar_subscriptions where organization_id=old.organization_id and employee_id=old.id;
 elsif new.user_id is distinct from old.user_id or new.archived_at is not null then
   delete from shiftly_private.calendar_subscriptions where organization_id=old.organization_id and employee_id=old.id;
 end if;
 return null;
end $$;
create trigger calendar_membership_removed after delete or update on public.memberships for each row execute function shiftly_private.revoke_calendar_identity();
create trigger calendar_employee_changed after update or delete on public.employees for each row execute function shiftly_private.revoke_calendar_identity();

create function shiftly_private.manage_calendar_subscription(org uuid,command text,token_digest text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare employee uuid; enabled boolean;
begin
 if auth.uid() is null then raise exception 'Permission denied'; end if;
 -- Match existing organization-first lifecycle lock order, then verify live access.
 perform 1 from public.organizations where id=org for no key update;
 select e.id into employee from public.employees e join public.memberships m
 on m.organization_id=e.organization_id and m.user_id=e.user_id
 where e.organization_id=org and e.user_id=auth.uid() and e.archived_at is null for update of e;
 if employee is null then raise exception 'Permission denied'; end if;
 if command='rotate' then
   if token_digest is null or token_digest !~ '^[a-f0-9]{64}$' then raise exception 'Invalid token'; end if;
   insert into shiftly_private.calendar_subscriptions(organization_id,employee_id,user_id,token_hash)
   values(org,employee,auth.uid(),token_digest)
   on conflict(organization_id,employee_id) do update set token_hash=excluded.token_hash,
     user_id=excluded.user_id,created_at=now(),expires_at=null,request_window=now(),request_count=0;
 elsif command='revoke' then
   delete from shiftly_private.calendar_subscriptions where organization_id=org and employee_id=employee;
 elsif command is distinct from 'status' then raise exception 'Unknown calendar action'; end if;
 select exists(select 1 from shiftly_private.calendar_subscriptions where organization_id=org and employee_id=employee
   and (expires_at is null or expires_at>now())) into enabled;
 return jsonb_build_object('active',enabled);
end $$;
create function public.manage_calendar_subscription(org uuid,command text,token_digest text default null) returns jsonb
language sql security invoker set search_path='' as $$select shiftly_private.manage_calendar_subscription(org,command,token_digest)$$;

-- Service-only feed reader. No employee/org parameters can expand token scope.
-- Invoked by POST RPC so durable rate-limit writes work with PostgREST.
create function shiftly_private.read_calendar_feed(token_digest text,request_bucket integer) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare subscription shiftly_private.calendar_subscriptions; count_requests integer; events jsonb;
begin
 if request_bucket is null or request_bucket not between 0 and 255 then return jsonb_build_object('status','invalid'); end if;
 insert into shiftly_private.calendar_request_buckets as b values(request_bucket,date_trunc('minute',now()),1)
 on conflict(bucket) do update set window_start=excluded.window_start,
 requests=case when b.window_start=excluded.window_start then b.requests+1 else 1 end
 returning requests into count_requests;
 if count_requests>600 then return jsonb_build_object('status','limited'); end if;
 if token_digest is null or token_digest !~ '^[a-f0-9]{64}$' then return jsonb_build_object('status','invalid'); end if;
 select * into subscription from shiftly_private.calendar_subscriptions where token_hash=token_digest for update;
 if subscription.employee_id is null or (subscription.expires_at is not null and subscription.expires_at<=now()) then
   return jsonb_build_object('status','invalid'); end if;
 if not exists(select 1 from public.employees e join public.memberships m on m.organization_id=e.organization_id and m.user_id=e.user_id
   where e.organization_id=subscription.organization_id and e.id=subscription.employee_id
   and e.user_id=subscription.user_id and e.archived_at is null) then return jsonb_build_object('status','invalid'); end if;
 update shiftly_private.calendar_subscriptions set request_window=date_trunc('minute',now()),
 request_count=case when request_window=date_trunc('minute',now()) then request_count+1 else 1 end
 where token_hash=token_digest returning request_count into count_requests;
 if count_requests>120 then return jsonb_build_object('status','limited'); end if;
 select coalesce(jsonb_agg(to_jsonb(e) order by e.shift_id),'[]'::jsonb) into events
 from shiftly_private.calendar_events e
 where e.organization_id=subscription.organization_id and e.employee_id=subscription.employee_id;
 return jsonb_build_object('status','ok','events',events);
end $$;
create function public.read_calendar_feed(token_digest text,request_bucket integer) returns jsonb
language sql security invoker set search_path='' as $$select shiftly_private.read_calendar_feed(token_digest,request_bucket)$$;

revoke all on function shiftly_private.sync_calendar_event(uuid,uuid,uuid),shiftly_private.track_calendar_publication(),shiftly_private.revoke_calendar_identity(),
 shiftly_private.manage_calendar_subscription(uuid,text,text),public.manage_calendar_subscription(uuid,text,text),
 shiftly_private.read_calendar_feed(text,integer),public.read_calendar_feed(text,integer) from public,anon,authenticated;
grant execute on function shiftly_private.manage_calendar_subscription(uuid,text,text),public.manage_calendar_subscription(uuid,text,text) to authenticated;
do $$begin
 if exists(select 1 from pg_roles where rolname='service_role') then
   grant usage on schema shiftly_private to service_role;
   grant execute on function shiftly_private.read_calendar_feed(text,integer),public.read_calendar_feed(text,integer) to service_role;
 end if;
end$$;
commit;
