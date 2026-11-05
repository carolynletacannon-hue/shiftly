begin;
-- Roster identity is independent of authentication. Legacy ids stay unchanged.
create table public.employees (
 organization_id uuid not null references public.organizations on delete cascade,
 id uuid not null default gen_random_uuid(),
 display_name text not null check(length(trim(display_name)) between 1 and 100),
 email text check(email is null or (length(email)<=254 and email=lower(trim(email)) and email like '%@%')),
 phone text not null default '' check(length(phone)<=50),
 user_id uuid references public.profiles,
 primary key(organization_id,id), unique(organization_id,user_id)
);
insert into public.employees(organization_id,id,display_name,user_id)
 select m.organization_id,m.user_id,coalesce(nullif(trim(p.display_name),''),'Team member'),m.user_id
 from public.memberships m join public.profiles p on p.id=m.user_id;
-- New memberships still get a roster record. Linked invitations pre-create the
-- chosen record before inserting membership, so this never creates a duplicate.
create function shiftly_private.roster_for_membership() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.employees(organization_id,id,display_name,user_id)
 select new.organization_id,new.user_id,coalesce(nullif(trim(display_name),''),'Team member'),new.user_id
 from public.profiles where id=new.user_id on conflict(organization_id,user_id) do nothing;
 return new;
end $$;
revoke all on function shiftly_private.roster_for_membership() from public,anon,authenticated;
create trigger roster_for_membership after insert on public.memberships
 for each row execute function shiftly_private.roster_for_membership();
alter table public.employees enable row level security;
create policy roster_read on public.employees for select to authenticated
 using(public.workspace_role_for(organization_id) is not null);
create policy roster_add on public.employees for insert to authenticated
 with check(public.workspace_role_for(organization_id) in ('owner','manager') and user_id is null);
create policy roster_edit on public.employees for update to authenticated
 using(public.workspace_role_for(organization_id) in ('owner','manager'))
 with check(public.workspace_role_for(organization_id) in ('owner','manager'));
revoke all on public.employees from public,anon,authenticated;
grant select(organization_id,id,display_name,user_id) on public.employees to authenticated;
-- Contact information is manager-only through the dedicated RPC below.
grant insert(organization_id,display_name,email,phone),update(display_name,email,phone) on public.employees to authenticated;
create function shiftly_private.employee_contacts(org uuid) returns table(id uuid,email text,phone text)
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Permission denied'; end if;
 return query select e.id,e.email,e.phone from public.employees e where e.organization_id=org;
end $$;
create function public.employee_contacts(org uuid) returns table(id uuid,email text,phone text)
language sql security invoker set search_path='' as $$ select * from shiftly_private.employee_contacts(org) $$;
revoke all on function shiftly_private.employee_contacts(uuid),public.employee_contacts(uuid) from public,anon;
grant execute on function shiftly_private.employee_contacts(uuid),public.employee_contacts(uuid) to authenticated;
alter table public.shifts drop constraint shifts_organization_id_employee_id_fkey;
alter table public.shifts add constraint shifts_roster_fkey foreign key(organization_id,employee_id) references public.employees(organization_id,id);
alter table public.published_shifts drop constraint published_shifts_employee_id_fkey;
-- Include historical publications even if their membership has since been removed.
insert into public.employees(organization_id,id,display_name,user_id)
 select distinct s.organization_id,s.employee_id,coalesce(nullif(trim(p.display_name),''),'Team member'),s.employee_id
 from public.published_shifts s join public.profiles p on p.id=s.employee_id
 on conflict do nothing;
alter table public.published_shifts add constraint published_shifts_roster_fkey foreign key(organization_id,employee_id) references public.employees(organization_id,id);
alter table public.invitations add column employee_id uuid;
alter table public.invitations add constraint invitations_roster_fkey foreign key(organization_id,employee_id) references public.employees(organization_id,id);
grant select(employee_id) on public.invitations to authenticated;
create index invitations_roster_idx on public.invitations(organization_id,employee_id);

create function shiftly_private.issue_roster_invitation(org uuid,employee uuid,invite_email text,token_digest text) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid; target public.employees;
begin
 -- Reuse existing authorization, throttling, email normalization and revocation.
 result:=shiftly_private.issue_invitation(org,invite_email,'employee',token_digest,null);
 select * into target from public.employees where organization_id=org and id=employee for update;
 if target.id is null or target.user_id is not null then raise exception 'Employee unavailable'; end if;
 update public.invitations set revoked_at=now() where organization_id=org and employee_id=employee and accepted_at is null and revoked_at is null;
 update public.invitations set employee_id=employee where id=result;
 return result;
end $$;
create function public.issue_roster_invitation(org uuid,employee uuid,invite_email text,token_digest text) returns uuid
language sql security invoker set search_path='' as $$ select shiftly_private.issue_roster_invitation(org,employee,invite_email,token_digest) $$;
revoke all on function shiftly_private.issue_roster_invitation(uuid,uuid,text,text),public.issue_roster_invitation(uuid,uuid,text,text) from public,anon;
grant execute on function shiftly_private.issue_roster_invitation(uuid,uuid,text,text),public.issue_roster_invitation(uuid,uuid,text,text) to authenticated;

create function shiftly_private.accept_roster_invitation(token_digest text) returns uuid
language plpgsql security definer set search_path='' as $$
declare invitation public.invitations; verified_email text; linked uuid;
begin
 select lower(email) into verified_email from auth.users where id=auth.uid() and email_confirmed_at is not null;
 if verified_email is null then raise exception 'Verify your email before accepting'; end if;
 -- Lock organization before invitation, matching invitation issuance lock order.
 select * into invitation from public.invitations where token_hash=token_digest;
 if invitation.id is null then raise exception 'Invitation invalid or expired'; end if;
 perform 1 from public.organizations where id=invitation.organization_id for no key update;
 select * into invitation from public.invitations where token_hash=token_digest for update;
 if invitation.accepted_at is not null or invitation.revoked_at is not null or invitation.expires_at<=now() or invitation.email<>verified_email then raise exception 'Invitation invalid or expired'; end if;
 if invitation.employee_id is not null then
   select user_id into linked from public.employees where organization_id=invitation.organization_id and id=invitation.employee_id for update;
   if not found or linked is not null then raise exception 'Employee already linked'; end if;
   -- Unique(org,user_id) rejects a second roster for an existing linked account.
   update public.employees set user_id=auth.uid() where organization_id=invitation.organization_id and id=invitation.employee_id;
 end if;
 insert into public.memberships values(invitation.organization_id,auth.uid(),invitation.role) on conflict do nothing;
 update public.invitations set accepted_at=now() where id=invitation.id;
 return invitation.organization_id;
end $$;
create or replace function public.accept_invitation(token_digest text) returns uuid
language sql security invoker set search_path='' as $$ select shiftly_private.accept_roster_invitation(token_digest) $$;
revoke all on function shiftly_private.accept_roster_invitation(text) from public,anon;
grant execute on function shiftly_private.accept_roster_invitation(text) to authenticated;

-- Atomic replacement of future coverage configuration; never touches shifts.
create table public.weekly_setup_versions (
 organization_id uuid primary key references public.organizations on delete cascade,
 revision integer not null default 0
);
alter table public.weekly_setup_versions enable row level security;
create policy weekly_setup_read on public.weekly_setup_versions for select to authenticated using(public.workspace_role_for(organization_id) in ('owner','manager'));
revoke all on public.weekly_setup_versions from public,anon,authenticated;
grant select on public.weekly_setup_versions to authenticated;
create function shiftly_private.save_weekly_setup(org uuid,items jsonb,expected_revision integer) returns void
language plpgsql security definer set search_path='' as $$
declare item jsonb; day jsonb; template uuid; current_version integer; total integer:=0;
begin
 if auth.uid() is null or coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Permission denied'; end if;
 perform 1 from public.organizations where id=org for no key update;
 if coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Permission denied'; end if;
 insert into public.weekly_setup_versions(organization_id) values(org) on conflict do nothing;
 select revision into current_version from public.weekly_setup_versions where organization_id=org for update;
 if current_version is distinct from expected_revision then raise exception 'Stale revision. Refresh before editing'; end if;
 if jsonb_typeof(items)<>'array' or jsonb_array_length(items)>50 or items is null then raise exception 'Invalid weekly setup'; end if;
 -- Pause old rules rather than deleting any rule referenced by historical slots.
 update public.coverage_requirements set is_active=false,revision=revision+1 where organization_id=org and is_active;
 for item in select value from jsonb_array_elements(items) loop
   template:=nullif(item->>'template_id','')::uuid;
   if template is null then
     insert into public.shift_templates(organization_id,name,start_time,end_time,end_next_day)
     values(org,trim(item->>'name'),(item->>'start_time')::time,(item->>'end_time')::time,coalesce((item->>'end_next_day')::boolean,false)) returning id into template;
   elsif not exists(select 1 from public.shift_templates where organization_id=org and id=template) then raise exception 'Template unavailable'; end if;
   if jsonb_typeof(item->'days')<>'array' or coalesce(jsonb_array_length(item->'days'),0)=0 or jsonb_array_length(item->'days')>7 then raise exception 'Choose weekdays'; end if;
   for day in select distinct value from jsonb_array_elements(item->'days') loop
     total:=total+(item->>'required_count')::integer;
     if total>300 then raise exception 'Weekly shift limit reached'; end if;
     insert into public.coverage_requirements(organization_id,template_id,weekday,position_id,required_count)
     values(org,template,(day#>>'{}')::smallint,nullif(item->>'position_id','')::uuid,(item->>'required_count')::smallint);
   end loop;
 end loop;
 update public.weekly_setup_versions set revision=revision+1 where organization_id=org;
end $$;
create function public.save_weekly_setup(org uuid,items jsonb,expected_revision integer) returns void
language sql security invoker set search_path='' as $$ select shiftly_private.save_weekly_setup(org,items,expected_revision) $$;
revoke all on function shiftly_private.save_weekly_setup(uuid,jsonb,integer),public.save_weekly_setup(uuid,jsonb,integer) from public,anon;
grant execute on function shiftly_private.save_weekly_setup(uuid,jsonb,integer),public.save_weekly_setup(uuid,jsonb,integer) to authenticated;

create or replace function shiftly_private.validate_schedule(target uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare s public.schedules;
begin
  select * into strict s from public.schedules where id=target;
  if exists(
    select 1 from public.shifts d where d.schedule_id=target and (
      (d.starts_at at time zone s.timezone)::date<s.week_start or
      (d.starts_at at time zone s.timezone)::date>=s.week_start+7 or
      (d.ends_at at time zone s.timezone)-(d.starts_at at time zone s.timezone)>interval '24 hours' or
      (d.ends_at at time zone s.timezone)::date>(d.starts_at at time zone s.timezone)::date+1
    )
  ) then
    raise exception 'Shift must start in this week and end within the next day (maximum 24 local hours)';
  end if;
  if exists(
    select 1 from public.shifts a join public.shifts b on
      a.organization_id=b.organization_id and a.employee_id=b.employee_id and
      a.employee_id is not null and a.id<>b.id and
      a.starts_at<b.ends_at and b.starts_at<a.ends_at
    where a.schedule_id=target
  ) or exists(
    select 1 from public.shifts a join public.published_shifts b on
      a.organization_id=b.organization_id and a.employee_id=b.employee_id and
      a.employee_id is not null and a.schedule_id<>b.schedule_id and
      a.starts_at<b.ends_at and b.starts_at<a.ends_at
    where a.schedule_id=target
  ) then
    raise exception 'Employee has overlapping shifts. Check this and adjacent weeks';
  end if;
  if exists(
    select 1 from public.shifts a left join public.employees m on
      m.organization_id=a.organization_id and m.id=a.employee_id
    where a.schedule_id=target and a.employee_id is not null and m.id is null
  ) then
    raise exception 'Assigned employee is unavailable';
  end if;
end $$;



create function shiftly_private.bump_weekly_setup() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.organizations where id=coalesce(new.organization_id,old.organization_id)) then return null; end if;
 insert into public.weekly_setup_versions(organization_id,revision) values(coalesce(new.organization_id,old.organization_id),1)
 on conflict(organization_id) do update set revision=public.weekly_setup_versions.revision+1;
 return null;
end $$;
revoke all on function shiftly_private.bump_weekly_setup() from public,anon,authenticated;
create trigger bump_weekly_setup after insert or update or delete on public.coverage_requirements
 for each row execute function shiftly_private.bump_weekly_setup();

commit;
