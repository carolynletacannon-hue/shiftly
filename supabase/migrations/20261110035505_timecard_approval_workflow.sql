begin;
-- Existing approvals and pending cards are untouched. Only newly inserted clock-out
-- receipts can trigger automatic approval; no historical backfill is performed.
alter table public.time_sessions add column approval_source text check(approval_source in ('automatic','manager'));

create function shiftly_private.time_approval_issues(target uuid,routine boolean default false) returns text[]
language plpgsql stable security invoker set search_path='' as $$
declare s public.time_sessions; issues text[]:='{}';begin
 select * into s from public.time_sessions where id=target;
 if s.id is null then return array['Timecard unavailable'];end if;
 if s.voided_at is not null then issues:=array_append(issues,'Voided timecard');end if;
 if s.clock_out is null then issues:=array_append(issues,'Missing clock-out');
 elsif s.clock_out<=s.clock_in or s.clock_out>clock_timestamp() or s.clock_in>clock_timestamp() then issues:=array_append(issues,'Invalid timestamps');end if;
 -- Different employees may overlap freely. Never compare workplace-wide hours.
 if exists(select 1 from public.time_sessions o where o.organization_id=s.organization_id and o.employee_id=s.employee_id and o.id<>s.id and o.voided_at is null and tstzrange(o.clock_in,o.clock_out,'[)') && tstzrange(s.clock_in,s.clock_out,'[)')) then issues:=array_append(issues,'Overlapping timecards for this employee');end if;
 if exists(select 1 from public.time_breaks b where b.organization_id=s.organization_id and b.session_id=s.id and (b.ends_at is null or b.starts_at<s.clock_in or b.ends_at>s.clock_out or b.ends_at<=b.starts_at)) or
 exists(select 1 from public.time_breaks a join public.time_breaks b on a.organization_id=b.organization_id and a.session_id=b.session_id and a.id<>b.id where a.organization_id=s.organization_id and a.session_id=s.id and tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(b.starts_at,b.ends_at,'[)')) then issues:=array_append(issues,'Incomplete or invalid unpaid breaks');end if;
 if exists(select 1 from public.time_correction_requests r where r.organization_id=s.organization_id and r.employee_id=s.employee_id and r.status='pending' and (r.session_id is null or r.session_id=s.id)) then issues:=array_append(issues,'Pending correction request');end if;
 if routine then
  if s.kiosk_id is null or exists(select 1 from public.time_audit a where a.organization_id=s.organization_id and a.session_id=s.id and a.action in ('correct','void')) then issues:=array_append(issues,'Manager-edited timecard requires individual review');end if;
  -- Require the complete immutable punch trail to match the actual timecard.
  if (select count(*) from public.time_punch_events where organization_id=s.organization_id and session_id=s.id and action='in' and occurred_at=s.clock_in)<>1 or
     (select count(*) from public.time_punch_events where organization_id=s.organization_id and session_id=s.id and action='out' and occurred_at=s.clock_out)<>1 or
     (select count(*) from public.time_punch_events where organization_id=s.organization_id and session_id=s.id)<>2+2*(select count(*) from public.time_breaks where organization_id=s.organization_id and session_id=s.id) or
     exists(select 1 from public.time_breaks b where b.organization_id=s.organization_id and b.session_id=s.id and
       (not exists(select 1 from public.time_punch_events p where p.organization_id=s.organization_id and p.session_id=s.id and p.action='break_start' and p.occurred_at=b.starts_at) or
        not exists(select 1 from public.time_punch_events p where p.organization_id=s.organization_id and p.session_id=s.id and p.action='break_end' and p.occurred_at=b.ends_at))) then issues:=array_append(issues,'Punch history requires individual review');end if;
 end if;
 return issues;
end$$;
revoke all on function shiftly_private.time_approval_issues(uuid,boolean) from public,anon,authenticated;

create function shiftly_private.time_approval_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.clock_in is distinct from old.clock_in or new.clock_out is distinct from old.clock_out or new.employee_id is distinct from old.employee_id or new.voided_at is distinct from old.voided_at then
  new.approved_at:=null;new.approved_by:=null;new.approval_source:=null;
  new.revision:=greatest(new.revision,old.revision+1);
 elsif new.approved_at is null then new.approval_source:=null;
 elsif new.approved_at is distinct from old.approved_at then new.approval_source:=coalesce(new.approval_source,'manager');end if;
 if old.approved_at is not null and new.approved_at is null then
  insert into public.time_audit(organization_id,employee_id,session_id,actor_id,action,reason,before_values,after_values)
  values(old.organization_id,old.employee_id,old.id,auth.uid(),'approval_invalidated','Timecard changed or correction requested',to_jsonb(old),to_jsonb(new));
 end if;return new;
end$$;
revoke all on function shiftly_private.time_approval_guard() from public,anon,authenticated;
create trigger time_approval_guard before update on public.time_sessions for each row execute function shiftly_private.time_approval_guard();

create function shiftly_private.time_approval_exception() returns trigger language plpgsql security definer set search_path='' as $$
declare org uuid; employee uuid; target uuid;begin
 if tg_table_name='time_correction_requests' then
  if new.status<>'pending' then return new;end if;
  org:=new.organization_id;employee:=new.employee_id;target:=new.session_id;
  perform 1 from public.organizations where id=org for no key update;
  update public.time_sessions set approved_at=null,approved_by=null,revision=revision+1
   where organization_id=org and employee_id=employee and (target is null or id=target) and approved_at is not null;
 elsif tg_table_name='time_breaks' then
  org:=coalesce(new.organization_id,old.organization_id);target:=coalesce(new.session_id,old.session_id);
  perform 1 from public.organizations where id=org for no key update;
  update public.time_sessions set approved_at=null,approved_by=null,revision=revision+1 where organization_id=org and id=target and approved_at is not null;
 else
  if new.voided_at is null then
   update public.time_sessions o set approved_at=null,approved_by=null,revision=o.revision+1
   where o.organization_id=new.organization_id and o.employee_id=new.employee_id and o.id<>new.id and o.voided_at is null and o.approved_at is not null and tstzrange(o.clock_in,o.clock_out,'[)') && tstzrange(new.clock_in,new.clock_out,'[)');
  end if;
 end if;return coalesce(new,old);
end$$;
revoke all on function shiftly_private.time_approval_exception() from public,anon,authenticated;
create trigger time_request_invalidates_approval after insert or update of status on public.time_correction_requests for each row execute function shiftly_private.time_approval_exception();
create trigger time_break_invalidates_approval after insert or update or delete on public.time_breaks for each row execute function shiftly_private.time_approval_exception();
create trigger time_overlap_invalidates_approval after insert or update of clock_in,clock_out,voided_at on public.time_sessions for each row execute function shiftly_private.time_approval_exception();

create function shiftly_private.time_auto_approve() returns trigger language plpgsql security definer set search_path='' as $$
declare s public.time_sessions;after_snapshot jsonb;begin
 if new.action<>'out' then return new;end if;
 perform 1 from public.organizations where id=new.organization_id for no key update;
 select * into s from public.time_sessions where organization_id=new.organization_id and id=new.session_id for update;
 if s.approved_at is null and cardinality(shiftly_private.time_approval_issues(s.id,true))=0 then
  update public.time_sessions set approved_at=clock_timestamp(),approved_by=null,approval_source='automatic',revision=revision+1 where id=s.id returning to_jsonb(time_sessions.*) into after_snapshot;
  insert into public.time_audit(organization_id,employee_id,session_id,kiosk_id,action,reason,before_values,after_values)
   values(s.organization_id,s.employee_id,s.id,new.kiosk_id,'auto_approve','Completed unmodified kiosk timecard with valid punches and no unresolved exceptions',to_jsonb(s),after_snapshot);
 end if;return new;
end$$;
revoke all on function shiftly_private.time_auto_approve() from public,anon,authenticated;
create trigger time_auto_approve after insert on public.time_punch_events for each row execute function shiftly_private.time_auto_approve();

-- Keep the prior authorized implementation private; all browser commands now
-- pass through this wrapper and the same organization lock as kiosk punches.
alter function shiftly_private.time_clock_manage(uuid,text,jsonb) rename to time_clock_manage_before_approval;
revoke all on function shiftly_private.time_clock_manage_before_approval(uuid,text,jsonb) from public,anon,authenticated;
create function shiftly_private.time_clock_manage(org uuid,command text,payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.time_sessions;issues text[];answer jsonb;lo timestamptz;hi timestamptz;zone text;candidates jsonb;fingerprint text;exceptions jsonb;item jsonb;approved integer:=0;begin
 if auth.uid() is null or public.workspace_role_for(org) is null then raise exception 'Permission denied';end if;
 perform 1 from public.organizations where id=org for no key update;
 if command in ('approve','bulk_preview','bulk_approve') then
  if coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Manager access required';end if;
  if not exists(select 1 from public.time_clock_settings where organization_id=org and enabled) then
   if command='bulk_preview' then return jsonb_build_object('count',0,'disabled',true,'exceptions','[]'::jsonb);end if;
   raise exception 'Time clock is disabled';end if;
  if command='approve' then
   select * into s from public.time_sessions where organization_id=org and id=(payload->>'session_id')::uuid for update;
   if s.id is null or s.revision is distinct from (payload->>'revision')::integer then raise exception 'Timecard changed. Refresh and review again';end if;
   issues:=shiftly_private.time_approval_issues(s.id,false);
   if cardinality(issues)>0 then raise exception 'Resolve timecard exceptions first: %',array_to_string(issues,', ');end if;
   if s.approved_at is not null then return jsonb_build_object('id',s.id,'already_approved',true);end if;
  else
   select timezone into zone from public.organizations where id=org;
   if (payload->>'to')::date<(payload->>'from')::date or (payload->>'to')::date-(payload->>'from')::date>366 then raise exception 'Choose a range of up to 366 days';end if;
   lo:=(payload->>'from')::date::timestamp at time zone zone;hi:=((payload->>'to')::date+1)::timestamp at time zone zone;
   if lo is null or hi is null then raise exception 'Date range required';end if;
   -- Only fully contained cards: an overnight crossing the filter remains available
   -- for individual review or a wider range. Never approve hidden outside hours.
   select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'revision',t.revision,'card',to_jsonb(t),'requests',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.time_correction_requests r where r.organization_id=org and r.employee_id=t.employee_id and (r.session_id is null or r.session_id=t.id)),'[]'),'breaks',coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from public.time_breaks b where b.organization_id=org and b.session_id=t.id),'[]')) order by t.id),'[]') into candidates
   from public.time_sessions t where t.organization_id=org and t.clock_in>=lo and t.clock_out<=hi and (nullif(payload->>'employee_id','') is null or t.employee_id=nullif(payload->>'employee_id','')::uuid) and t.approved_at is null and t.voided_at is null and cardinality(shiftly_private.time_approval_issues(t.id,true))=0;
   if jsonb_array_length(candidates)>1000 then
    if command='bulk_preview' then return jsonb_build_object('count',jsonb_array_length(candidates),'too_many',true,'exceptions','[]'::jsonb);end if;
    raise exception 'More than 1,000 eligible timecards. Narrow the date range';end if;
   fingerprint:=md5(candidates::text);
   if command='bulk_preview' then
    select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'issues',shiftly_private.time_approval_issues(t.id,true)) order by t.id),'[]') into exceptions from public.time_sessions t where t.organization_id=org and t.clock_in<hi and (t.clock_out is null or t.clock_out>lo) and t.voided_at is null and t.approved_at is null and (nullif(payload->>'employee_id','') is null or t.employee_id=nullif(payload->>'employee_id','')::uuid) and cardinality(shiftly_private.time_approval_issues(t.id,true))>0;
    return jsonb_build_object('count',jsonb_array_length(candidates),'token',fingerprint,'exceptions',exceptions);end if;
   if coalesce((payload->>'confirmed')::boolean,false) is not true then raise exception 'Manager confirmation required';end if;
   if payload->>'token' is distinct from fingerprint then raise exception 'Timecards changed. Refresh the bulk preview and confirm again';end if;
   if jsonb_array_length(candidates)=0 then return jsonb_build_object('approved',0);end if;
   for item in select * from jsonb_array_elements(candidates) loop
    perform shiftly_private.time_clock_manage_before_approval(org,'approve',jsonb_build_object('session_id',item->>'id','revision',item->'revision'));
    approved:=approved+1;
   end loop;
   insert into public.time_audit(organization_id,actor_id,action,reason,after_values) values(org,auth.uid(),'bulk_approve','Manager confirmed eligible timecards in selected range',jsonb_build_object('from',payload->>'from','to',payload->>'to','count',approved));
   return jsonb_build_object('approved',approved);
  end if;
 end if;
 answer:=shiftly_private.time_clock_manage_before_approval(org,command,payload);return answer;
end$$;
revoke all on function shiftly_private.time_clock_manage(uuid,text,jsonb) from public,anon;
grant execute on function shiftly_private.time_clock_manage(uuid,text,jsonb) to authenticated;
-- Recreate the public wrapper so dependency/plans resolve the new guarded entry.
create or replace function public.time_clock_manage(org uuid,command text,payload jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$select shiftly_private.time_clock_manage(org,command,payload)$$;
commit;
