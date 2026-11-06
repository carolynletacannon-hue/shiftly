begin;
-- Extend the existing recipient-only inbox. Historical rows stay intact.
alter table public.shift_notifications alter column request_id drop not null;
alter table public.shift_notifications add column category text not null default 'coverage'
 check(category in ('coverage','swap','time_off','schedule_change','approval','schedule_published'));
alter table public.shift_notifications add column event_key text;
alter table public.shift_notifications add column href text;
alter table public.shift_notifications add column read_at timestamptz;
create unique index notification_event_once on public.shift_notifications(organization_id,user_id,event_key);
create index notification_request_idx on public.shift_notifications(request_id) where request_id is not null;
create index notification_unread on public.shift_notifications(organization_id,user_id) where read_at is null;
grant update(read_at) on public.shift_notifications to authenticated;
create policy notification_mark_read on public.shift_notifications for update to authenticated
 using(user_id=(select auth.uid()) and public.workspace_role_for(organization_id) is not null)
 with check(user_id=(select auth.uid()) and public.workspace_role_for(organization_id) is not null);

create table public.notification_preferences (
 organization_id uuid not null references public.organizations on delete cascade,
 user_id uuid not null references public.profiles on delete cascade,
 coverage boolean not null default true, swap boolean not null default true,
 time_off boolean not null default true, schedule_change boolean not null default true,
 approval boolean not null default true, schedule_published boolean not null default false,
 reminder_24h boolean not null default false, reminder_1h boolean not null default false,
 primary key(organization_id,user_id),
 foreign key(organization_id,user_id) references public.memberships(organization_id,user_id) on delete cascade
);
alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from public,anon,authenticated;
grant select,insert,update on public.notification_preferences to authenticated;
create policy own_preferences on public.notification_preferences for all to authenticated
 using(user_id=(select auth.uid()) and public.workspace_role_for(organization_id) is not null)
 with check(user_id=(select auth.uid()) and public.workspace_role_for(organization_id) is not null);

-- Internal writers are only called by trusted business transaction triggers.
create function shiftly_private.notify(org uuid,recipient uuid,category text,event_key text,message text,href text) returns void
language sql security definer set search_path='' as $$
 insert into public.shift_notifications(organization_id,user_id,category,event_key,message,href,request_id)
 select org,recipient,category,event_key,message,href,case when event_key like 'transfer:%' then split_part(event_key,':',2)::uuid end
 where exists(select 1 from public.memberships m join public.employees e on e.organization_id=m.organization_id and e.user_id=m.user_id
 where m.organization_id=org and m.user_id=recipient and e.archived_at is null)
 on conflict(organization_id,user_id,event_key) do nothing
$$;
revoke all on function shiftly_private.notify(uuid,uuid,text,text,text,text) from public,anon,authenticated;

-- Replace noisy command-level fanout with semantic status events. Commands still
-- enforce consent, manager approval, organization locks and stale revisions.
do $$declare definition text; begin
 select pg_get_functiondef('shiftly_private.shift_request_command(uuid,text,jsonb)'::regprocedure) into definition;
 if position(' insert into public.shift_notifications' in definition)=0 then raise exception 'Review shift command before migration'; end if;
 definition:=substring(definition from 1 for position(' insert into public.shift_notifications' in definition)-1)||E' return to_jsonb(r);\nend $function$;';
 -- Official assignment events have their own dedicated message.
 definition:=replace(definition,'   update public.published_shifts set employee_id=r.replacement_employee',
  E'   perform set_config(''meadowmark.transfer_event'',''true'',true);\n   update public.published_shifts set employee_id=r.replacement_employee');
 definition:=replace(definition,' return to_jsonb(r);',E' perform set_config(''meadowmark.transfer_event'','''',true);\n return to_jsonb(r);');
 definition:=replace(definition,'''decline'',''approve'')', '''decline'',''approve'',''withdraw'')');
 definition:=replace(definition,'p.require_manager or command=''manual''', 'p.require_manager or command in (''manual'',''swap'')');
 definition:=replace(definition,' if command=''cancel'' then', E' if command=''withdraw'' then\n   if r.status<>''pending'' or r.accepted_by is distinct from actor then raise exception ''Only the pending volunteer may withdraw''; end if;\n   update public.shift_requests set status=''cancelled'' where id=r.id returning * into r;\n elsif command=''cancel'' then');
 execute definition;
end $$;
update public.shift_requests set manager_required=true where kind='swap' and status in ('open','pending');
create function shiftly_private.notify_transfer() returns trigger language plpgsql security definer set search_path='' as $$
declare recipient uuid; category text; message text; key text;
begin

 category:=case when new.kind='swap' then 'swap' else 'coverage' end;
 if not exists(select 1 from public.shift_requests r where r.id=new.id and r.status=new.status) then return null; end if;
 if tg_op='UPDATE' and old.status=new.status then return null; end if;
 key:='transfer:'||new.id||':'||new.status;
 message:=case new.status
 when 'open' then case when new.kind='swap' then 'A coworker requested a shift swap with you. Review and respond.' else 'A shift coverage request is open.' end
 when 'pending' then case when new.kind='swap' then 'Shift swap accepted. Manager approval is still required; assignments have not changed.' else 'Someone offered to cover the shift. Manager approval is still required; assignments have not changed.' end
 when 'completed' then case when new.kind='swap' then 'Shift swap approved and official. Your published schedule has changed.' else 'Coverage is official. The published shift assignment has changed.' end
 when 'denied' then 'The manager rejected the '||category||' request. Assignments have not changed.'
 when 'declined' then 'The shift swap proposal was declined. Assignments have not changed.'
 else 'The '||category||' request was cancelled. Check your current schedule.' end;
 -- An open coverage offer is visible on Shift Requests, without emailing everyone.
 for recipient in select distinct u from (
 select new.requester u where new.status<>'open'
 union select e.user_id from public.employees e where e.organization_id=new.organization_id
 and e.id in (new.original_employee,new.replacement_employee) and (new.status<>'open' or (new.kind='swap' and e.id=new.replacement_employee))
 ) x where u is not null and not(new.status='pending' and exists(select 1 from public.memberships m where m.organization_id=new.organization_id and m.user_id=u and m.role in ('owner','manager'))) loop
 perform shiftly_private.notify(new.organization_id,recipient,category,key,message,'/workspaces/'||new.organization_id||'/shift-requests#request-'||new.id);
 end loop;
 if new.status='pending' then
 for recipient in select user_id from public.memberships where organization_id=new.organization_id and role in ('owner','manager') loop
 perform shiftly_private.notify(new.organization_id,recipient,'approval',key,'A '||category||' request needs your approval.','/workspaces/'||new.organization_id||'/shift-requests#request-'||new.id);
 end loop;
 end if;
 return null;
end $$;
revoke all on function shiftly_private.notify_transfer() from public,anon,authenticated;
-- Deferred status events inspect the final committed request state. An
-- automatically completed transfer never emits a pending-approval message.
create constraint trigger notify_transfer_final after insert or update on public.shift_requests deferrable initially deferred for each row execute function shiftly_private.notify_transfer();

-- Reuse existing time-off event records, mirror into the single inbox, and stop
-- the previous independent SMTP path so a decision produces only one email.
create function shiftly_private.notify_time_off() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform shiftly_private.notify(new.organization_id,new.recipient_id,case when new.event='submitted' then 'approval' else 'time_off' end,
 'time-off:'||new.id,case new.event when 'submitted' then 'A new time-off request needs your review.' else 'Your time-off request was '||new.event||'.' end,
 '/workspaces/'||new.organization_id||'/time-off#request-'||new.request_id);
 return new;
end $$;
revoke all on function shiftly_private.notify_time_off() from public,anon,authenticated;
create trigger notification_time_off after insert on public.time_off_notifications for each row execute function shiftly_private.notify_time_off();
create or replace function shiftly_private.claim_time_off_email(request uuid)
returns table(id uuid,email text,event text,organization_id uuid)
language sql security definer set search_path='' as $$ select null::uuid,null::text,null::text,null::uuid where false $$;

-- Preserve pending employee cancellation; add manager-only approved revocation.
do $$declare definition text; begin
 select pg_get_functiondef('shiftly_private.time_off_command(uuid,text,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,'''approve'',''deny'',''cancel'',''remove_manual'')', '''approve'',''deny'',''cancel'',''remove_manual'',''revoke'')');
 definition:=replace(definition,'   if command=''cancel'' then', E'   if command=''revoke'' then\n     if actor_role not in (''owner'',''manager'') or request.status<>''approved'' then raise exception ''Approved time off and manager permission required''; end if;\n   elsif command=''cancel'' then');
 definition:=replace(definition,'command<>''remove_manual'' and request.status<>''pending''', 'command not in (''remove_manual'',''revoke'') and request.status<>''pending''');
 definition:=replace(definition,'''approve'',''deny'',''remove_manual'')', '''approve'',''deny'',''remove_manual'',''revoke'')');
 execute definition;
end $$;
create function shiftly_private.notify_time_off_cancelled() returns trigger language plpgsql security definer set search_path='' as $$
declare recipient uuid;
begin
 if old.status='approved' and new.status='cancelled' then
 select user_id into recipient from public.employees where organization_id=new.organization_id and id=new.employee_id;
 perform shiftly_private.notify(new.organization_id,recipient,'time_off','time-off-cancel:'||new.id,
 'Your previously approved time off was cancelled. Review the request and contact your manager.','/workspaces/'||new.organization_id||'/time-off#request-'||new.id);
 end if;
 return new;
end $$;
revoke all on function shiftly_private.notify_time_off_cancelled() from public,anon,authenticated;
create trigger notification_time_off_cancelled after update on public.time_off_requests for each row execute function shiftly_private.notify_time_off_cancelled();

-- Per-publication snapshots avoid delete/reinsert noise and draft notifications.
create table shiftly_private.notification_schedule_snapshots (
 schedule_id uuid primary key references public.schedules on delete cascade,
 shifts jsonb not null
);
revoke all on shiftly_private.notification_schedule_snapshots from public,anon,authenticated;
insert into shiftly_private.notification_schedule_snapshots
 select p.id,coalesce((select jsonb_agg(to_jsonb(s)) from public.published_shifts s where s.schedule_id=p.id),'[]') from public.published_schedules p;
create function shiftly_private.notify_publication() returns trigger language plpgsql security definer set search_path='' as $$
declare previous jsonb; current_shifts jsonb; recipient record; before_shifts jsonb; after_shifts jsonb; tz text; week date;
begin
 select shifts into previous from shiftly_private.notification_schedule_snapshots where schedule_id=new.schedule_id;
 select coalesce(jsonb_agg(to_jsonb(s)),'[]') into current_shifts from public.published_shifts s where schedule_id=new.schedule_id;
 select timezone,week_start into tz,week from public.published_schedules where id=new.schedule_id;
 if coalesce(current_setting('meadowmark.transfer_event',true),'')<>'true' then
 for recipient in select e.id,e.user_id from public.employees e join public.memberships m on m.organization_id=e.organization_id and m.user_id=e.user_id
 where e.organization_id=new.organization_id and e.archived_at is null loop
 select coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','start',x->>'starts_at','end',x->>'ends_at') order by x->>'id'),'[]') into before_shifts
 from jsonb_array_elements(coalesce(previous,'[]')) x where x->>'employee_id'=recipient.id::text;
 select coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','start',x->>'starts_at','end',x->>'ends_at') order by x->>'id'),'[]') into after_shifts
 from jsonb_array_elements(current_shifts) x where x->>'employee_id'=recipient.id::text;
 if previous is not null and before_shifts<>after_shifts then
 perform shiftly_private.notify(new.organization_id,recipient.user_id,'schedule_change','publication:'||new.schedule_id||':'||new.revision,
 'Your published schedule changed. Previous shifts ('||tz||'): '||coalesce((select string_agg(to_char((x->>'start')::timestamptz at time zone tz,'Mon DD HH24:MI')||' – '||to_char((x->>'end')::timestamptz at time zone tz,'Mon DD HH24:MI'),'; ') from jsonb_array_elements(before_shifts) x),'none')||
 '. Current shifts: '||coalesce((select string_agg(to_char((x->>'start')::timestamptz at time zone tz,'Mon DD HH24:MI')||' – '||to_char((x->>'end')::timestamptz at time zone tz,'Mon DD HH24:MI'),'; ') from jsonb_array_elements(after_shifts) x),'none')||'.',
 '/workspaces/'||new.organization_id||'/my-schedule?week='||week);
 elsif previous is null and after_shifts<>'[]' and exists(select 1 from public.notification_preferences p where p.organization_id=new.organization_id and p.user_id=recipient.user_id and p.schedule_published) then
 perform shiftly_private.notify(new.organization_id,recipient.user_id,'schedule_published','publication:'||new.schedule_id||':'||new.revision,
 'Your weekly schedule is published. View your assigned shifts in Meadowmark.','/workspaces/'||new.organization_id||'/my-schedule?week='||week);
 end if;
 end loop;
 end if;
 insert into shiftly_private.notification_schedule_snapshots values(new.schedule_id,current_shifts)
 on conflict(schedule_id) do update set shifts=excluded.shifts;
 return new;
end $$;
revoke all on function shiftly_private.notify_publication() from public,anon,authenticated;
create trigger notification_publication after insert on public.schedule_events for each row execute function shiftly_private.notify_publication();

-- Preserve historical time-off updates in the consolidated inbox without
-- replaying historical email. Resolved manager items are marked read below.
select shiftly_private.notify(t.organization_id,t.recipient_id,
 case when t.event='submitted' then 'approval' else 'time_off' end,
 'time-off:'||t.id,
 case when t.event='submitted' then 'A time-off request was submitted. View its current status.' else 'Your time-off request was '||t.event||'.' end,
 '/workspaces/'||t.organization_id||'/time-off#request-'||t.request_id)
 from public.time_off_notifications t;
update public.shift_notifications n set read_at=now()
 where n.category='approval' and exists(select 1 from public.time_off_notifications t join public.time_off_requests r on r.id=t.request_id where n.event_key='time-off:'||t.id and r.status<>'pending');
update public.shift_notifications n set category=case when r.kind='swap' then 'swap' else 'coverage' end,
 href='/workspaces/'||n.organization_id||'/shift-requests#request-'||n.request_id
 from public.shift_requests r where r.id=n.request_id and n.event_key is null;

-- Existing outbox, bounded claims, preference/current-authorization checks.
alter table public.shift_email_deliveries add column claim_token uuid;
alter table public.shift_email_deliveries add column skipped_at timestamptz;
create index notification_email_ready on public.shift_email_deliveries(claimed_until) where sent_at is null and skipped_at is null and attempts<5;
-- Never replay historical pending email automatically on rollout.
update public.shift_email_deliveries set skipped_at=now() where sent_at is null;
drop function public.claim_shift_emails();
create function public.claim_shift_emails() returns setof public.shift_email_deliveries language sql security invoker set search_path='' as $$
 update public.shift_email_deliveries d set attempts=d.attempts+1,claimed_until=now()+interval '10 minutes',claim_token=gen_random_uuid()
 where d.id in (
 select q.id from public.shift_email_deliveries q
 join public.shift_notifications n on n.id=q.id
 join public.memberships m on m.organization_id=q.organization_id and m.user_id=q.user_id
 join public.employees e on e.organization_id=m.organization_id and e.user_id=m.user_id and e.archived_at is null
 left join public.notification_preferences p on p.organization_id=q.organization_id and p.user_id=q.user_id
 where q.sent_at is null and q.skipped_at is null and q.attempts<5 and (q.claimed_until is null or q.claimed_until<now())
 and n.created_at>now()-interval '7 days'
 and (n.request_id is null or n.event_key is null or exists(select 1 from public.shift_requests r where r.id=n.request_id and r.status=split_part(n.event_key,':',3)))
 and (n.event_key not like 'time-off:%' or exists(select 1 from public.time_off_notifications t join public.time_off_requests r on r.id=t.request_id where n.event_key='time-off:'||t.id and (t.event=r.status or (t.event='submitted' and r.status='pending'))))
 and coalesce((to_jsonb(p)->>n.category)::boolean,n.category<>'schedule_published')
 and (n.category<>'approval' or (m.role in ('owner','manager') and (
 exists(select 1 from public.shift_requests r where r.id=n.request_id and r.status='pending') or
 exists(select 1 from public.time_off_notifications t join public.time_off_requests r on r.id=t.request_id where n.event_key='time-off:'||t.id and r.status='pending'))))
 order by n.created_at,n.id limit 10 for update of q skip locked
 ) returning d.*
$$;
-- Service-role invoker accesses the private queue; browser roles cannot claim.
revoke all on function public.claim_shift_emails() from public,anon,authenticated;
do $$begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.claim_shift_emails() to service_role; end if; end $$;
do $$begin if exists(select 1 from pg_roles where rolname='service_role') then grant select on public.shift_notifications,public.memberships,public.employees,public.notification_preferences,public.shift_requests,public.time_off_requests,public.time_off_notifications to service_role; end if; end $$;

create function public.notification_email_eligible(notification uuid,token uuid) returns boolean
language sql security invoker set search_path='' as $$
 select exists(select 1 from public.shift_email_deliveries q
 join public.shift_notifications n on n.id=q.id
 join public.memberships m on m.organization_id=q.organization_id and m.user_id=q.user_id
 join public.employees e on e.organization_id=m.organization_id and e.user_id=m.user_id and e.archived_at is null
 left join public.notification_preferences p on p.organization_id=m.organization_id and p.user_id=m.user_id
 where q.id=notification and q.claim_token=token and q.claimed_until>now() and q.sent_at is null and q.skipped_at is null
 and (n.request_id is null or n.event_key is null or exists(select 1 from public.shift_requests r where r.id=n.request_id and r.status=split_part(n.event_key,':',3)))
 and (n.event_key not like 'time-off:%' or exists(select 1 from public.time_off_notifications t join public.time_off_requests r on r.id=t.request_id where n.event_key='time-off:'||t.id and (t.event=r.status or (t.event='submitted' and r.status='pending'))))
 and coalesce((to_jsonb(p)->>n.category)::boolean,n.category<>'schedule_published')
 and (n.category<>'approval' or (m.role in ('owner','manager') and (
 exists(select 1 from public.shift_requests r where r.id=n.request_id and r.status='pending') or
 exists(select 1 from public.time_off_notifications t join public.time_off_requests r on r.id=t.request_id where n.event_key='time-off:'||t.id and r.status='pending')))))
$$;
revoke all on function public.notification_email_eligible(uuid,uuid) from public,anon,authenticated;
do $$begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.notification_email_eligible(uuid,uuid) to service_role; end if; end $$;

create function shiftly_private.resolve_approval_notification() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status not in ('open','pending') then
 if tg_table_name='shift_requests' then
 update public.shift_notifications set read_at=coalesce(read_at,now()),message='This shift request has been resolved. View its current status.'
 where organization_id=new.organization_id and request_id=new.id and category='approval';
 else
 update public.shift_notifications n set read_at=coalesce(n.read_at,now()),message='This time-off request has been resolved. View its current status.'
 where n.organization_id=new.organization_id and n.category='approval' and exists(select 1 from public.time_off_notifications t where t.request_id=new.id and n.event_key='time-off:'||t.id);
 end if;
 end if;
 return new;
end $$;
revoke all on function shiftly_private.resolve_approval_notification() from public,anon,authenticated;
create trigger resolve_shift_approval after update on public.shift_requests for each row execute function shiftly_private.resolve_approval_notification();
create trigger resolve_time_off_approval after update on public.time_off_requests for each row execute function shiftly_private.resolve_approval_notification();
commit;
