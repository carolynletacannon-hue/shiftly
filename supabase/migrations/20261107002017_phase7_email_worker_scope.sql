-- Add a workspace-scoped claim without altering global claims or queue records.
-- Same eligibility, lease, retry cap and fencing rules as claim_shift_emails().
begin;
create function public.claim_workspace_notification_emails(workspace uuid) returns setof public.shift_email_deliveries language sql security invoker set search_path='' as $$
 update public.shift_email_deliveries d set attempts=d.attempts+1,claimed_until=now()+interval '10 minutes',claim_token=gen_random_uuid()
 where d.id in (
 select q.id from public.shift_email_deliveries q
 join public.shift_notifications n on n.id=q.id
 join public.memberships m on m.organization_id=q.organization_id and m.user_id=q.user_id
 join public.employees e on e.organization_id=m.organization_id and e.user_id=m.user_id and e.archived_at is null
 left join public.notification_preferences p on p.organization_id=q.organization_id and p.user_id=q.user_id
 where q.organization_id=workspace and q.sent_at is null and q.skipped_at is null and q.attempts<5 and (q.claimed_until is null or q.claimed_until<now())
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
revoke all on function public.claim_workspace_notification_emails(uuid) from public,anon,authenticated;
do $$begin
 if exists(select 1 from pg_roles where rolname='service_role') then
  grant execute on function public.claim_workspace_notification_emails(uuid) to service_role;
 end if;
end $$;
commit;
