begin;
-- No production settings/data change. Each workplace must explicitly opt in.
create table public.time_clock_settings (
 organization_id uuid primary key references public.organizations,
 enabled boolean not null default false, require_breaks boolean not null default false
);
create table public.time_kiosks (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations,
 name text not null check(length(trim(name)) between 1 and 80),
 enrolled_by uuid not null references public.profiles, created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '12 hours', last_activity timestamptz,
 revoked_at timestamptz, unique(organization_id,id)
);
create table shiftly_private.kiosk_credentials (
 kiosk_id uuid primary key references public.time_kiosks, token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 window_start timestamptz not null default now(), attempts integer not null default 0,
 failures integer not null default 0, locked_until timestamptz,
 challenge_hash text, employee_id uuid, challenge_expires timestamptz
);
create table shiftly_private.employee_pins (
 organization_id uuid not null, employee_id uuid not null, lookup_hash text not null check(lookup_hash ~ '^[a-f0-9]{64}$'),
 pin_hash text not null check(pin_hash ~ '^[a-f0-9]{32}:[a-f0-9]{64}$'),
 updated_at timestamptz not null default now(), updated_by uuid not null references public.profiles,
 primary key(organization_id,employee_id), unique(organization_id,lookup_hash),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id)
);
create table public.time_sessions (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, employee_id uuid not null,
 kiosk_id uuid, clock_in timestamptz not null, clock_out timestamptz,
 voided_at timestamptz, revision integer not null default 1, approved_at timestamptz, approved_by uuid references public.profiles,
 created_at timestamptz not null default now(), unique(organization_id,id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id),
 foreign key(organization_id,kiosk_id) references public.time_kiosks(organization_id,id),
 check(isfinite(clock_in) and (clock_out is null or (isfinite(clock_out) and clock_out>clock_in)))
);
create unique index time_one_open_session on public.time_sessions(organization_id,employee_id) where clock_out is null and voided_at is null;
create index time_sessions_employee_idx on public.time_sessions(organization_id,employee_id,clock_in);
create index time_sessions_range_idx on public.time_sessions(organization_id,clock_in,clock_out);
create table public.time_breaks (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, session_id uuid not null,
 starts_at timestamptz not null, ends_at timestamptz,
 foreign key(organization_id,session_id) references public.time_sessions(organization_id,id),
 check(isfinite(starts_at) and (ends_at is null or (isfinite(ends_at) and ends_at>starts_at)))
);
create unique index time_one_open_break on public.time_breaks(session_id) where ends_at is null;
create index time_breaks_session_idx on public.time_breaks(organization_id,session_id);
create table public.time_punch_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, session_id uuid not null,
 kiosk_id uuid not null, request_id uuid not null, action text not null check(action in ('in','out','break_start','break_end')),
 occurred_at timestamptz not null default now(), result jsonb not null,
 unique(kiosk_id,request_id),
 foreign key(organization_id,session_id) references public.time_sessions(organization_id,id),
 foreign key(organization_id,kiosk_id) references public.time_kiosks(organization_id,id)
);
create index time_punch_session_idx on public.time_punch_events(organization_id,session_id);
create table public.time_correction_requests (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, employee_id uuid not null,
 session_id uuid, reason text not null check(length(trim(reason)) between 5 and 1000),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 requested_by uuid not null references public.profiles, created_at timestamptz not null default now(),
 reviewed_by uuid references public.profiles, reviewed_at timestamptz, response text,
 foreign key(organization_id,employee_id) references public.employees(organization_id,id),
 foreign key(organization_id,session_id) references public.time_sessions(organization_id,id)
);
create index time_requests_employee_idx on public.time_correction_requests(organization_id,employee_id,status);
create table public.time_audit (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations,
 employee_id uuid, session_id uuid, kiosk_id uuid, actor_id uuid references public.profiles,
 action text not null, reason text, before_values jsonb, after_values jsonb, created_at timestamptz not null default now(),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id),
 foreign key(organization_id,session_id) references public.time_sessions(organization_id,id),
 foreign key(organization_id,kiosk_id) references public.time_kiosks(organization_id,id)
);
create index time_audit_session_idx on public.time_audit(organization_id,session_id);
create index time_audit_employee_idx on public.time_audit(organization_id,employee_id,created_at);

-- RLS is defense in depth; every write is through an authorized command below.
alter table shiftly_private.kiosk_credentials enable row level security;
alter table shiftly_private.employee_pins enable row level security;
revoke all on shiftly_private.kiosk_credentials,shiftly_private.employee_pins from public,anon,authenticated;
create function shiftly_private.time_can_read(org uuid,employee uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and (public.workspace_role_for(org) in ('owner','manager') or
 (public.workspace_role_for(org) is not null and exists(select 1 from public.employees e where e.organization_id=org and e.id=employee and e.user_id=auth.uid() and e.archived_at is null)))
$$;
revoke all on function shiftly_private.time_can_read(uuid,uuid) from public,anon;
grant execute on function shiftly_private.time_can_read(uuid,uuid) to authenticated;
do $$declare t text;begin
 foreach t in array array['time_clock_settings','time_kiosks','time_sessions','time_breaks','time_punch_events','time_correction_requests','time_audit'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 end loop;
end$$;
create policy time_settings_read on public.time_clock_settings for select to authenticated using(public.workspace_role_for(organization_id) is not null);
create policy time_kiosks_read on public.time_kiosks for select to authenticated using(public.workspace_role_for(organization_id) in ('owner','manager'));
create policy time_sessions_read on public.time_sessions for select to authenticated using(shiftly_private.time_can_read(organization_id,employee_id));
create policy time_breaks_read on public.time_breaks for select to authenticated using(exists(select 1 from public.time_sessions s where s.organization_id=time_breaks.organization_id and s.id=session_id));
create policy time_punch_read on public.time_punch_events for select to authenticated using(exists(select 1 from public.time_sessions s where s.organization_id=time_punch_events.organization_id and s.id=session_id));
create policy time_requests_read on public.time_correction_requests for select to authenticated using(shiftly_private.time_can_read(organization_id,employee_id));
create policy time_audit_read on public.time_audit for select to authenticated using(shiftly_private.time_can_read(organization_id,employee_id));
create function shiftly_private.time_immutable() returns trigger language plpgsql set search_path='' as $$begin raise exception 'Time history is immutable';end$$;
revoke all on function shiftly_private.time_immutable() from public,anon,authenticated;
create trigger time_audit_immutable before update or delete on public.time_audit for each row execute function shiftly_private.time_immutable();
create trigger time_punch_immutable before update or delete on public.time_punch_events for each row execute function shiftly_private.time_immutable();

-- Credential invalidation follows lifecycle changes, so restoring/reconnecting never
-- resurrects an old PIN. No attendance history is removed.
create function shiftly_private.time_invalidate_pin() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='memberships' then
  update shiftly_private.kiosk_credentials c set challenge_hash=null from public.employees e where e.organization_id=old.organization_id and e.user_id=old.user_id and c.employee_id=e.id and c.kiosk_id in(select id from public.time_kiosks where organization_id=old.organization_id);
  delete from shiftly_private.employee_pins p using public.employees e where e.organization_id=old.organization_id and e.user_id=old.user_id and p.organization_id=e.organization_id and p.employee_id=e.id;
 else
  if new.archived_at is distinct from old.archived_at or new.user_id is distinct from old.user_id then
   delete from shiftly_private.employee_pins where organization_id=new.organization_id and employee_id=new.id;
   update shiftly_private.kiosk_credentials set challenge_hash=null where employee_id=new.id and kiosk_id in(select id from public.time_kiosks where organization_id=new.organization_id);
  end if;
 end if;
 return null;
end$$;
revoke all on function shiftly_private.time_invalidate_pin() from public,anon,authenticated;
create trigger time_invalidate_employee_pin after update of archived_at,user_id on public.employees for each row execute function shiftly_private.time_invalidate_pin();
create trigger time_invalidate_member_pin after delete on public.memberships for each row execute function shiftly_private.time_invalidate_pin();

-- Call only while holding the organization's lock, then employee lock.
create function shiftly_private.time_validate(target uuid) returns void language plpgsql set search_path='' as $$
declare s public.time_sessions;begin
 select * into strict s from public.time_sessions where id=target;
 if exists(select 1 from public.time_sessions o where o.organization_id=s.organization_id and o.employee_id=s.employee_id and o.id<>s.id and o.voided_at is null and
   tstzrange(o.clock_in,o.clock_out,'[)') && tstzrange(s.clock_in,s.clock_out,'[)')) then raise exception 'Work sessions must not overlap';end if;
 if exists(select 1 from public.time_breaks b where b.session_id=s.id and (b.starts_at<s.clock_in or (s.clock_out is not null and (b.ends_at is null or b.ends_at>s.clock_out)))) then raise exception 'Breaks must be inside the work session';end if;
 if exists(select 1 from public.time_breaks a join public.time_breaks b on a.session_id=b.session_id and a.id<>b.id where a.session_id=s.id and tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(b.starts_at,b.ends_at,'[)')) then raise exception 'Breaks must not overlap';end if;
end$$;
revoke all on function shiftly_private.time_validate(uuid) from public,anon,authenticated;

create function shiftly_private.time_clock_manage(org uuid,command text,payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare manager boolean; e public.employees; s public.time_sessions; k public.time_kiosks; r public.time_correction_requests;
 before_snapshot jsonb; after_snapshot jsonb; target uuid; item jsonb; v_reason text:=trim(payload->>'reason');
begin
 if auth.uid() is null or public.workspace_role_for(org) is null then raise exception 'Permission denied';end if;
 -- Same lock order as roster lifecycle/scheduling. Serializes revocation and punches.
 perform 1 from public.organizations where id=org for no key update;
 manager:=coalesce(public.workspace_role_for(org)::text,'') in ('owner','manager');
 if public.workspace_role_for(org) is null then raise exception 'Permission denied';end if;
 if command='request' then
  select * into e from public.employees where organization_id=org and user_id=auth.uid() and archived_at is null for update;
  if e.id is null or length(coalesce(v_reason,'')) not between 5 and 1000 then raise exception 'Employee and explanation required';end if;
  target:=nullif(payload->>'session_id','')::uuid;
  if target is not null and not exists(select 1 from public.time_sessions where id=target and organization_id=org and employee_id=e.id) then raise exception 'Timecard unavailable';end if;
  insert into public.time_correction_requests(organization_id,employee_id,session_id,reason,requested_by) values(org,e.id,target,v_reason,auth.uid()) returning id into target;
  return jsonb_build_object('id',target);
 end if;
 if not manager then raise exception 'Manager access required';end if;
 if command='settings' then
  insert into public.time_clock_settings values(org,coalesce((payload->>'enabled')::boolean,false),coalesce((payload->>'require_breaks')::boolean,false))
  on conflict(organization_id) do update set enabled=excluded.enabled,require_breaks=excluded.require_breaks;
  insert into public.time_audit(organization_id,actor_id,action,after_values) values(org,auth.uid(),'settings',payload);
  return '{"ok":true}';
 end if;
 if not exists(select 1 from public.time_clock_settings where organization_id=org and enabled) then raise exception 'Time clock is disabled';end if;
 if command='enroll' then
  if payload->>'token_hash' is null or payload->>'token_hash' !~ '^[a-f0-9]{64}$' then raise exception 'Invalid credential';end if;
  insert into public.time_kiosks(organization_id,name,enrolled_by) values(org,trim(payload->>'name'),auth.uid()) returning * into k;
  insert into shiftly_private.kiosk_credentials(kiosk_id,token_hash) values(k.id,payload->>'token_hash');
  insert into public.time_audit(organization_id,kiosk_id,actor_id,action) values(org,k.id,auth.uid(),'enroll');
  return jsonb_build_object('id',k.id);
 elsif command='revoke' then
  update public.time_kiosks set revoked_at=now() where organization_id=org and id=(payload->>'kiosk_id')::uuid and revoked_at is null returning * into k;
  if k.id is null then raise exception 'Kiosk unavailable';end if;
  insert into public.time_audit(organization_id,kiosk_id,actor_id,action) values(org,k.id,auth.uid(),'revoke');
  return '{"ok":true}';
 elsif command='pin' then
  select * into e from public.employees where organization_id=org and id=(payload->>'employee_id')::uuid and archived_at is null for update;
  if e.id is null or (e.archived_user_id is not null and e.user_id is null) or (e.user_id is not null and not exists(select 1 from public.memberships where organization_id=org and user_id=e.user_id)) then raise exception 'Employee unavailable';end if;
  insert into shiftly_private.employee_pins values(org,e.id,payload->>'lookup_hash',payload->>'pin_hash',now(),auth.uid())
   on conflict(organization_id,employee_id) do update set lookup_hash=excluded.lookup_hash,pin_hash=excluded.pin_hash,updated_at=now(),updated_by=auth.uid();
  -- Invalidate any PIN challenges issued before reset.
  update shiftly_private.kiosk_credentials c set challenge_hash=null where c.employee_id=e.id and c.kiosk_id in(select id from public.time_kiosks where organization_id=org);
  insert into public.time_audit(organization_id,employee_id,actor_id,action) values(org,e.id,auth.uid(),'pin_reset');
  return '{"ok":true}';
 elsif command in ('correct','approve','review','void') then
  if command='review' then
   select * into r from public.time_correction_requests where id=(payload->>'request_id')::uuid and organization_id=org and status='pending' for update;
   if r.id is null or length(coalesce(v_reason,'')) not between 5 and 1000 or payload->>'decision' not in ('approved','rejected') then raise exception 'Pending request and response required';end if;
   -- Approval must point at an actual applied correction for this employee/request.
   if payload->>'decision'='approved' and not exists(select 1 from public.time_audit a where a.organization_id=org and a.employee_id=r.employee_id and a.action='correct' and a.after_values->>'request_id'=r.id::text) then raise exception 'Apply the requested correction before approving';end if;
   update public.time_correction_requests set status=payload->>'decision',response=v_reason,reviewed_by=auth.uid(),reviewed_at=now() where id=r.id;
   insert into public.time_audit(organization_id,employee_id,session_id,actor_id,action,reason,before_values,after_values) values(org,r.employee_id,r.session_id,auth.uid(),'request_review',v_reason,to_jsonb(r),jsonb_build_object('decision',payload->>'decision'));
   return '{"ok":true}';
  end if;
  target:=nullif(payload->>'session_id','')::uuid;
  if target is not null then
   select * into s from public.time_sessions where id=target and organization_id=org for update;
   if s.id is null or s.revision is distinct from (payload->>'revision')::integer then raise exception 'Timecard changed. Refresh and review again';end if;
   select to_jsonb(s)||jsonb_build_object('breaks',coalesce((select jsonb_agg(to_jsonb(b)) from public.time_breaks b where b.session_id=s.id),'[]')) into before_snapshot;
   select * into e from public.employees where organization_id=org and id=s.employee_id for update;
  else
   select * into e from public.employees where organization_id=org and id=(payload->>'employee_id')::uuid for update;
  end if;
  if e.id is null then raise exception 'Employee unavailable';end if;
  if s.voided_at is not null then raise exception 'Voided records are immutable; add a corrected work session';end if;
  if command='void' then
   if s.id is null or length(coalesce(v_reason,'')) not between 5 and 1000 then raise exception 'Timecard and explanation required';end if;
   update public.time_sessions set voided_at=now(),approved_at=null,approved_by=null,revision=revision+1 where id=s.id;
  elsif command='approve' then
   if s.id is null or s.clock_out is null or exists(select 1 from public.time_correction_requests where organization_id=org and employee_id=e.id and status='pending' and (session_id is null or session_id=s.id)) then raise exception 'Resolve open punches and correction requests first';end if;
   update public.time_sessions set approved_at=now(),approved_by=auth.uid(),revision=revision+1 where id=s.id;
  else
   if length(coalesce(v_reason,'')) not between 5 and 1000 then raise exception 'Correction explanation required';end if;
   if payload->>'request_id' is not null and not exists(select 1 from public.time_correction_requests where organization_id=org and id=(payload->>'request_id')::uuid and employee_id=e.id and status='pending' and (session_id is null or session_id=s.id)) then raise exception 'Correction request unavailable';end if;
   if target is null then
    insert into public.time_sessions(organization_id,employee_id,clock_in,clock_out) values(org,e.id,(payload->>'clock_in')::timestamptz,nullif(payload->>'clock_out','')::timestamptz) returning id into target;
   else
    update public.time_sessions set clock_in=(payload->>'clock_in')::timestamptz,clock_out=nullif(payload->>'clock_out','')::timestamptz,revision=revision+1,approved_at=null,approved_by=null where id=target;
   end if;
   if jsonb_typeof(payload->'breaks') is distinct from 'array' or jsonb_array_length(payload->'breaks')>30 then raise exception 'Provide all recorded breaks';end if;
   delete from public.time_breaks where session_id=target;
   for item in select * from jsonb_array_elements(payload->'breaks') loop
    insert into public.time_breaks(organization_id,session_id,starts_at,ends_at) values(org,target,(item->>'starts_at')::timestamptz,nullif(item->>'ends_at','')::timestamptz);
   end loop;
   perform shiftly_private.time_validate(target);
   if exists(select 1 from public.time_sessions where id=target and (clock_in>now() or clock_out>now())) then raise exception 'Future time corrections are not allowed';end if;
  end if;
  select to_jsonb(t)||jsonb_build_object('breaks',coalesce((select jsonb_agg(to_jsonb(b)) from public.time_breaks b where b.session_id=target),'[]'),'request_id',payload->>'request_id') into after_snapshot from public.time_sessions t where t.id=target;
  insert into public.time_audit(organization_id,employee_id,session_id,actor_id,action,reason,before_values,after_values) values(org,e.id,target,auth.uid(),command,v_reason,before_snapshot,after_snapshot);
  return jsonb_build_object('id',target);
 end if;
 raise exception 'Unknown time clock action';
end$$;
create function public.time_clock_manage(org uuid,command text,payload jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$select shiftly_private.time_clock_manage(org,command,payload)$$;
revoke all on function shiftly_private.time_clock_manage(uuid,text,jsonb),public.time_clock_manage(uuid,text,jsonb) from public,anon;
grant execute on function shiftly_private.time_clock_manage(uuid,text,jsonb),public.time_clock_manage(uuid,text,jsonb) to authenticated;

-- Only server-side service_role can call this boundary. No browser service key.
create function shiftly_private.time_clock_kiosk(credential text,command text,payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare k public.time_kiosks; c shiftly_private.kiosk_credentials; e public.employees; s public.time_sessions; b public.time_breaks;
 p shiftly_private.employee_pins; result jsonb; prior public.time_punch_events; org uuid; stamp timestamptz;
begin
 select d.organization_id into org from public.time_kiosks d join shiftly_private.kiosk_credentials x on x.kiosk_id=d.id where x.token_hash=credential;
 if org is null then return '{"error":"Kiosk authorization required"}';end if;
 perform 1 from public.organizations where id=org for no key update;
 select d.* into k from public.time_kiosks d join shiftly_private.kiosk_credentials x on x.kiosk_id=d.id where x.token_hash=credential for update of d;
 if k.id is null or k.revoked_at is not null or k.expires_at<=clock_timestamp() or not exists(select 1 from public.time_clock_settings where organization_id=org and enabled) then return '{"error":"Kiosk authorization required"}';end if;
 select * into c from shiftly_private.kiosk_credentials where kiosk_id=k.id for update;
 stamp:=clock_timestamp();
 if stamp-c.window_start>=interval '1 minute' then c.window_start:=stamp;c.attempts:=0;end if;
 update shiftly_private.kiosk_credentials set window_start=c.window_start,attempts=c.attempts+1 where kiosk_id=k.id;
 if c.attempts>=120 then return '{"error":"Please wait before trying again"}';end if;
 update public.time_kiosks set last_activity=stamp where id=k.id;
 if command='info' then
  return (select jsonb_build_object('org',org,'name',o.name,'timezone',o.timezone,'now',stamp,'require_breaks',t.require_breaks) from public.organizations o join public.time_clock_settings t on t.organization_id=o.id where o.id=org);
 elsif command='rotate' then
  if payload->>'token_hash' is null or payload->>'token_hash' !~ '^[a-f0-9]{64}$' then raise exception 'Invalid credential';end if;
  update shiftly_private.kiosk_credentials set token_hash=payload->>'token_hash',challenge_hash=null where kiosk_id=k.id;
  -- Rotation never extends the manager-authorized twelve-hour lifetime.
  insert into public.time_audit(organization_id,kiosk_id,action) values(org,k.id,'rotate');
  return '{"ok":true}';
 elsif command='end' then
  update public.time_kiosks set revoked_at=stamp where id=k.id;
  insert into public.time_audit(organization_id,kiosk_id,action) values(org,k.id,'end');
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
create function public.time_clock_kiosk(credential text,command text,payload jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$select shiftly_private.time_clock_kiosk(credential,command,payload)$$;
revoke all on function shiftly_private.time_clock_kiosk(text,text,jsonb),public.time_clock_kiosk(text,text,jsonb) from public,anon,authenticated;
-- Test fixtures on older milestones may omit service_role. Supabase always has it.
do $$begin if exists(select 1 from pg_roles where rolname='service_role') then
 grant usage on schema shiftly_private to service_role;
 grant execute on function shiftly_private.time_clock_kiosk(text,text,jsonb),public.time_clock_kiosk(text,text,jsonb) to service_role;
end if;end$$;
commit;
