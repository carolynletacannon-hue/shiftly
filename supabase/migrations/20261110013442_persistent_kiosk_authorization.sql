begin;
-- Keep the legacy column for compatibility and history; enrollment has no deadline.
alter table public.time_kiosks alter column expires_at drop not null;
alter table public.time_kiosks alter column expires_at drop default;
-- Existing valid device secrets remain valid, including offline legacy enrollments.
-- Revocations, ownership, PINs, audit and time records are untouched.
update public.time_kiosks set expires_at=null where revoked_at is null;
alter table shiftly_private.kiosk_credentials add column pending_token_hash text
 unique check(pending_token_hash ~ '^[a-f0-9]{64}$');

create or replace function shiftly_private.time_clock_kiosk(credential text,command text,payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare k public.time_kiosks; c shiftly_private.kiosk_credentials; e public.employees; s public.time_sessions; b public.time_breaks;
 p shiftly_private.employee_pins; result jsonb; prior public.time_punch_events; org uuid; stamp timestamptz;
begin
 select d.organization_id into org from public.time_kiosks d join shiftly_private.kiosk_credentials x on x.kiosk_id=d.id where (x.token_hash=credential or x.pending_token_hash=credential);
 if org is null then return '{"error":"Kiosk authorization required"}';end if;
 perform 1 from public.organizations where id=org for no key update;
 select d.* into k from public.time_kiosks d join shiftly_private.kiosk_credentials x on x.kiosk_id=d.id where (x.token_hash=credential or x.pending_token_hash=credential) for update of d;
 if k.id is null or k.revoked_at is not null then return '{"error":"Kiosk authorization required"}';end if;
 select * into c from shiftly_private.kiosk_credentials where kiosk_id=k.id for update;
 -- A candidate becomes authoritative only after the browser presents it.
 -- Before acknowledgement the old credential survives response loss/offline time.
 if c.pending_token_hash=credential then
  update shiftly_private.kiosk_credentials set token_hash=c.pending_token_hash,pending_token_hash=null where kiosk_id=k.id;
  c.token_hash:=credential;c.pending_token_hash:=null;
 end if;
 stamp:=clock_timestamp();
 -- Exit bypasses feature flags and request throttles, but still verifies the device.
 if command='end' then
  update public.time_kiosks set revoked_at=stamp where id=k.id;
  update shiftly_private.kiosk_credentials set pending_token_hash=null,challenge_hash=null,employee_id=null where kiosk_id=k.id;
  insert into public.time_audit(organization_id,kiosk_id,action) values(org,k.id,'end');
  return '{"ok":true}';
 end if;
 if not exists(select 1 from public.time_clock_settings where organization_id=org and enabled) then return '{"error":"Kiosk authorization required"}';end if;
 if stamp-c.window_start>=interval '1 minute' then c.window_start:=stamp;c.attempts:=0;end if;
 update shiftly_private.kiosk_credentials set window_start=c.window_start,attempts=c.attempts+1 where kiosk_id=k.id;
 if c.attempts>=120 then return '{"error":"Please wait before trying again"}';end if;
 update public.time_kiosks set last_activity=stamp where id=k.id;
 if command='info' then
  return (select jsonb_build_object('org',org,'name',o.name,'timezone',o.timezone,'now',stamp,'require_breaks',t.require_breaks) from public.organizations o join public.time_clock_settings t on t.organization_id=o.id where o.id=org);
 elsif command='rotate' then
  if payload->>'token_hash' is null or payload->>'token_hash' !~ '^[a-f0-9]{64}$' then raise exception 'Invalid credential';end if;
  if c.pending_token_hash is not null and c.pending_token_hash<>payload->>'token_hash' then
   return '{"error":"Credential renewal pending. Retry using the current device credential."}';
  end if;
  if c.pending_token_hash is not null then return '{"ok":true}';end if;
  update shiftly_private.kiosk_credentials set pending_token_hash=payload->>'token_hash' where kiosk_id=k.id;
  -- Employee challenges keep their independent thirty-second lifetime.
  insert into public.time_audit(organization_id,kiosk_id,action) values(org,k.id,'rotate');
  return '{"ok":true}';
 elsif command='lookup' then
  if c.locked_until>stamp then return '{"error":"PIN unavailable. Wait and try again or ask your manager"}';end if;
  -- Count BEFORE validation and commit failures; never raise/roll back rate limits.
  update shiftly_private.kiosk_credentials set failures=case when c.locked_until<=stamp then 1 else failures+1 end,
   locked_until=case when c.locked_until<=stamp then null when failures>=4 then stamp+interval '5 minutes' else locked_until end,
   challenge_hash=null,employee_id=null where kiosk_id=k.id;
  if c.failures=4 and (c.locked_until is null or c.locked_until<=stamp) then insert into public.time_audit(organization_id,kiosk_id,action) values(org,k.id,'pin_lockout');end if;
  select x.* into p from shiftly_private.employee_pins x where x.organization_id=org and x.lookup_hash=payload->>'lookup_hash';
  select * into e from public.employees where organization_id=org and id=p.employee_id and archived_at is null and
   (archived_user_id is null or user_id is not null) and (user_id is null or exists(select 1 from public.memberships m where m.organization_id=org and m.user_id=employees.user_id));
  if e.id is null then return '{"hash":"invalid"}';end if;
  -- This hash is returned ONLY to server-side service_role, never the kiosk response.
  return jsonb_build_object('hash',p.pin_hash,'employee_id',e.id,'org',org);
 elsif command='authorize' then
  if c.locked_until>stamp and c.failures>5 then return '{"error":"PIN unavailable. Wait and try again or ask your manager"}';end if;
  select * into e from public.employees where organization_id=org and id=(payload->>'employee_id')::uuid and archived_at is null and
   (archived_user_id is null or user_id is not null) and (user_id is null or exists(select 1 from public.memberships m where m.organization_id=org and m.user_id=employees.user_id));
  if e.id is null or not exists(select 1 from shiftly_private.employee_pins x where x.organization_id=org and x.employee_id=e.id and x.pin_hash=payload->>'verified_hash') or payload->>'challenge_hash' is null or payload->>'challenge_hash' !~ '^[a-f0-9]{64}$' then return '{"error":"PIN unavailable. Wait and try again or ask your manager"}';end if;
  update shiftly_private.kiosk_credentials set failures=0,locked_until=null,employee_id=e.id,challenge_hash=payload->>'challenge_hash',challenge_expires=stamp+interval '30 seconds' where kiosk_id=k.id;
  select * into s from public.time_sessions where organization_id=org and employee_id=e.id and clock_out is null and voided_at is null;
  return jsonb_build_object('name',split_part(e.display_name,' ',1),'status',case when s.id is null then 'out' when exists(select 1 from public.time_breaks where session_id=s.id and ends_at is null) then 'break' else 'working' end);
 elsif command='punch' then
  -- Retries can retrieve only their previous receipt, never reapply a transition.
  select * into prior from public.time_punch_events where kiosk_id=k.id and request_id=(payload->>'request_id')::uuid;
  if prior.id is not null then
   if prior.action is distinct from payload->>'action' then return '{"error":"Retry action mismatch"}';end if;
   return prior.result;
  end if;
  if c.challenge_hash is null or c.challenge_hash is distinct from payload->>'challenge_hash' or c.challenge_expires<=stamp then return '{"error":"Enter your PIN again"}';end if;
  select * into e from public.employees where organization_id=org and id=c.employee_id and archived_at is null and
   (archived_user_id is null or user_id is not null) and (user_id is null or exists(select 1 from public.memberships m where m.organization_id=org and m.user_id=employees.user_id)) for update;
  if e.id is null then return '{"error":"Enter your PIN again"}';end if;
  select * into s from public.time_sessions where organization_id=org and employee_id=e.id and clock_out is null and voided_at is null for update;
  select * into b from public.time_breaks where session_id=s.id and ends_at is null for update;
  if payload->>'action'='in' and s.id is null then
   insert into public.time_sessions(organization_id,employee_id,kiosk_id,clock_in) values(org,e.id,k.id,stamp) returning * into s;
  elsif payload->>'action'='out' and s.id is not null and b.id is null then
   update public.time_sessions set clock_out=stamp,revision=revision+1 where id=s.id;
  elsif payload->>'action'='break_start' and s.id is not null and b.id is null then
   insert into public.time_breaks(organization_id,session_id,starts_at) values(org,s.id,stamp);
   update public.time_sessions set revision=revision+1 where id=s.id;
  elsif payload->>'action'='break_end' and b.id is not null then
   update public.time_breaks set ends_at=stamp where id=b.id;
   update public.time_sessions set revision=revision+1 where id=s.id;
  else return '{"error":"That action is unavailable. Enter your PIN again"}';end if;
  perform shiftly_private.time_validate(s.id);
  result:=jsonb_build_object('ok',true,'at',stamp,'action',payload->>'action');
  insert into public.time_punch_events(organization_id,session_id,kiosk_id,request_id,action,occurred_at,result) values(org,s.id,k.id,(payload->>'request_id')::uuid,payload->>'action',stamp,result);
  update shiftly_private.kiosk_credentials set challenge_hash=null,employee_id=null where kiosk_id=k.id;
  return result;
 end if;
 raise exception 'Unknown kiosk action';
end$$;
-- CREATE OR REPLACE retains the existing service_role-only EXECUTE grants.
commit;
