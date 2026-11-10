begin;
create table public.payroll_settings (
 organization_id uuid primary key references public.organizations,
 frequency text not null check(frequency in ('weekly','biweekly','semimonthly','monthly')),
 anchor date not null check(isfinite(anchor)), timezone text not null,
 workweek_day integer not null check(workweek_day between 1 and 7),
 workweek_time time not null, rule text not null check(rule in ('unverified','federal-weekly-confirmed')),
 employee_access boolean not null default false,
 check(frequency<>'semimonthly' or extract(day from anchor)<=15)
);
create table public.payroll_rates (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, employee_id uuid not null,
 effective_at timestamptz not null check(isfinite(effective_at)), cents bigint not null check(cents between 1 and 99999999),
 classification text not null check(classification in ('hourly_nonexempt','exempt_review','other_review')),
 reason text not null check(length(trim(reason)) between 5 and 1000),
 created_at timestamptz not null default clock_timestamp(), actor_id uuid not null references public.profiles,
 foreign key(organization_id,employee_id) references public.employees(organization_id,id)
);
create index payroll_rates_employee_idx on public.payroll_rates(organization_id,employee_id,effective_at,created_at);
create table public.payroll_reports (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations,
 period_start timestamptz not null, period_end timestamptz not null check(period_end>period_start),
 version integer not null, snapshot jsonb not null, source jsonb not null,
 actor_id uuid not null references public.profiles, reason text not null check(length(trim(reason)) between 5 and 1000),
 created_at timestamptz not null default now(), unique(organization_id,period_start,period_end,version),unique(organization_id,id)
);
create table public.payroll_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations,
 report_id uuid, action text not null check(action in ('settings','rate','approve','reopen')),
 actor_id uuid not null references public.profiles, reason text not null, details jsonb not null default '{}',
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,report_id) references public.payroll_reports(organization_id,id)
);
create index payroll_events_org_idx on public.payroll_events(organization_id,created_at);
do $$declare t text;begin
 foreach t in array array['payroll_settings','payroll_rates','payroll_reports','payroll_events'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 if exists(select 1 from pg_roles where rolname='service_role') then execute format('revoke all on public.%I from service_role',t);end if;
 execute format('grant select on public.%I to authenticated',t);
 end loop;
end$$;
create policy payroll_settings_read on public.payroll_settings for select to authenticated using(public.workspace_role_for(organization_id) is not null);
create policy payroll_rates_read on public.payroll_rates for select to authenticated using(
 public.workspace_role_for(organization_id) in ('owner','manager') or
 (exists(select 1 from public.payroll_settings s where s.organization_id=payroll_rates.organization_id and s.employee_access)
 and public.workspace_role_for(organization_id) is not null and exists(select 1 from public.employees e where e.organization_id=payroll_rates.organization_id and e.id=employee_id and e.user_id=auth.uid() and e.archived_at is null)));
create policy payroll_reports_read on public.payroll_reports for select to authenticated using(public.workspace_role_for(organization_id) in ('owner','manager'));
create policy payroll_events_read on public.payroll_events for select to authenticated using(public.workspace_role_for(organization_id) in ('owner','manager'));
create trigger payroll_rates_immutable before update or delete on public.payroll_rates for each row execute function shiftly_private.time_immutable();
create trigger payroll_reports_immutable before update or delete on public.payroll_reports for each row execute function shiftly_private.time_immutable();
create trigger payroll_events_immutable before update or delete on public.payroll_events for each row execute function shiftly_private.time_immutable();
-- One MVCC statement captures all sources. Invoker preserves employee RLS.
create function public.payroll_input(org uuid) returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'settings',(select to_jsonb(s) from public.payroll_settings s where s.organization_id=org),
 'employees',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'display_name',e.display_name,'archived_at',e.archived_at,'user_id',e.user_id) order by e.id) from public.employees e where e.organization_id=org and (public.workspace_role_for(org) in ('owner','manager') or e.user_id=auth.uid())),'[]'),
 'rates',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('cents',r.cents::text) order by r.id) from public.payroll_rates r where r.organization_id=org),'[]'),
 'cards',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('time_breaks',coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from public.time_breaks b where b.organization_id=org and b.session_id=c.id),'[]')) order by c.id) from public.time_sessions c where c.organization_id=org),'[]'),
 'requests',coalesce((select jsonb_agg(jsonb_build_object('employee_id',r.employee_id,'status',r.status) order by r.id) from public.time_correction_requests r where r.organization_id=org),'[]'))
 where public.workspace_role_for(org) is not null;
$$;
revoke all on function public.payroll_input(uuid) from public,anon;
grant execute on function public.payroll_input(uuid) to authenticated;
create function shiftly_private.payroll_manage(org uuid,command text,payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare target uuid; why text:=trim(payload->>'reason');before_settings jsonb;begin
 if auth.uid() is null or coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Manager access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(org::text,10));
 if why is null or length(why) not between 5 and 1000 then raise exception 'Explanation required (5–1000 characters)';end if;
 if command='settings' then
  if not exists(select 1 from pg_timezone_names where name=payload->>'timezone') then raise exception 'Invalid timezone';end if;
  select to_jsonb(s) into before_settings from public.payroll_settings s where organization_id=org;
  insert into public.payroll_settings values(org,payload->>'frequency',(payload->>'anchor')::date,payload->>'timezone',(payload->>'workweek_day')::integer,(payload->>'workweek_time')::time,payload->>'rule',coalesce((payload->>'employee_access')::boolean,false))
  on conflict(organization_id) do update set frequency=excluded.frequency,anchor=excluded.anchor,timezone=excluded.timezone,workweek_day=excluded.workweek_day,workweek_time=excluded.workweek_time,rule=excluded.rule,employee_access=excluded.employee_access;
 elsif command='rate' then
  insert into public.payroll_rates(organization_id,employee_id,effective_at,cents,classification,reason,actor_id) values(org,(payload->>'employee_id')::uuid,(payload->>'effective_at')::timestamptz,(payload->>'cents')::bigint,payload->>'classification',why,auth.uid()) returning id into target;
 elsif command='reopen' then
  select id into target from public.payroll_reports where organization_id=org and id=(payload->>'report_id')::uuid;
  if target is null then raise exception 'Report unavailable';end if;
 else raise exception 'Unknown command';end if;
 insert into public.payroll_events(organization_id,report_id,action,actor_id,reason,details) values(org,case when command='reopen' then target end,command,auth.uid(),why,jsonb_build_object('input',payload,'before_settings',before_settings));return target;
end$$;
revoke all on function shiftly_private.payroll_manage(uuid,text,jsonb) from public,anon,authenticated;
create function public.payroll_manage(org uuid,command text,payload jsonb) returns uuid language sql security invoker set search_path='' as $$select shiftly_private.payroll_manage(org,command,payload)$$;
grant execute on function shiftly_private.payroll_manage(uuid,text,jsonb) to authenticated;
revoke all on function public.payroll_manage(uuid,text,jsonb) from public,anon;
grant execute on function public.payroll_manage(uuid,text,jsonb) to authenticated;
-- Service-only: the server computes estimates; browsers cannot supply an approved snapshot.
create function public.payroll_approve(org uuid,actor uuid,expected jsonb,report jsonb,why text) returns uuid
language plpgsql security definer set search_path='' as $$
declare target uuid;v integer;begin
 if not exists(select 1 from public.memberships where organization_id=org and user_id=actor and role in ('owner','manager')) then raise exception 'Manager access required';end if;
 if why is null or length(trim(why)) not between 5 and 1000 then raise exception 'Explanation required';end if;
 perform pg_advisory_xact_lock(hashtextextended(org::text,10));
 -- Prevent source writes during the compare-and-snapshot boundary.
 lock table public.time_sessions,public.time_breaks,public.time_correction_requests,public.employees,public.payroll_settings,public.payroll_rates in share mode;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 if public.payroll_input(org) is distinct from expected then raise exception 'Sources changed. Refresh and review again';end if;
 if report->>'version'<>'federal-weekly-v1' or jsonb_array_length(report->'warnings')<>0 or jsonb_array_length(report->'rows')=0 or (report->>'end')::timestamptz>now() then raise exception 'Resolve exceptions and finish the pay period before approval';end if;
 select coalesce(max(version),0)+1 into v from public.payroll_reports where organization_id=org and period_start=(report->>'start')::timestamptz and period_end=(report->>'end')::timestamptz;
 if v>1 and not exists(select 1 from public.payroll_events e join public.payroll_reports r on r.id=e.report_id where r.organization_id=org and r.period_start=(report->>'start')::timestamptz and r.period_end=(report->>'end')::timestamptz and r.version=v-1 and e.action='reopen') then raise exception 'Reopen the previous version with an explanation first';end if;
 insert into public.payroll_reports(organization_id,period_start,period_end,version,snapshot,source,actor_id,reason) values(org,(report->>'start')::timestamptz,(report->>'end')::timestamptz,v,report,expected,actor,why) returning id into target;
 insert into public.payroll_events(organization_id,report_id,action,actor_id,reason) values(org,target,'approve',actor,why);return target;
end$$;
revoke all on function public.payroll_approve(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
do $$begin if exists(select 1 from pg_roles where rolname='service_role') then
 revoke all on function public.payroll_input(uuid),public.payroll_manage(uuid,text,jsonb),shiftly_private.payroll_manage(uuid,text,jsonb) from service_role;
 grant execute on function public.payroll_approve(uuid,uuid,jsonb,jsonb,text) to service_role;
 end if;end$$;
commit;
