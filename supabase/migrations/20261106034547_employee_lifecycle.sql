begin;
alter table public.employees add column archived_at timestamptz,
 add column archived_user_id uuid references public.profiles;
grant select(archived_at) on public.employees to authenticated;
create index employees_active_idx on public.employees(organization_id,id) where archived_at is null;

-- Lifecycle audit references deliberately prevent subsequent physical deletion.
create table public.employee_events (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations,
 employee_id uuid not null, actor_id uuid not null references public.profiles,
 action text not null check(action in ('archive','restore')),
 created_at timestamptz not null default now(),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id)
);
alter table public.employee_events enable row level security;
revoke all on public.employee_events from public,anon,authenticated;
grant select on public.employee_events to authenticated;
create index employee_events_employee_idx on public.employee_events(organization_id,employee_id);
create index employee_events_actor_idx on public.employee_events(actor_id);
create index employees_archived_user_idx on public.employees(archived_user_id) where archived_user_id is not null;
create policy employee_events_read on public.employee_events for select to authenticated
 using(public.workspace_role_for(organization_id) in ('owner','manager'));

-- Single, authorized membership removal boundary. No authentication users are deleted.
-- Organization locking serializes this operation with invitations and scheduling.
create function shiftly_private.remove_roster_membership(org uuid,member uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Permission denied'; end if;
 perform 1 from public.organizations where id=org for no key update;
 if coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Permission denied'; end if;
 if exists(select 1 from public.memberships where organization_id=org and user_id=member and role='owner') and
   (public.workspace_role_for(org)<>'owner' or (select count(*) from public.memberships where organization_id=org and role='owner')<=1) then
   raise exception 'Only an owner can remove another owner, and at least one owner must remain.';
 end if;
 delete from public.memberships where organization_id=org and user_id=member;
end $$;
revoke all on function shiftly_private.remove_roster_membership(uuid,uuid) from public,anon,authenticated;

-- Inspect every foreign key, including future dependencies and cascading ones,
-- before allowing deletion. Also include the non-FK assignment audit snapshots.
create function shiftly_private.employee_delete_reasons(org uuid,employee uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare dep record; present boolean; reasons jsonb:='[]';
begin
 if exists(select 1 from public.employees where organization_id=org and id=employee and (user_id is not null or archived_user_id is not null)) then
   reasons:=reasons||jsonb_build_array('This employee has a connected account history.');
 end if;
 for dep in
   select c.conrelid::regclass as relation,
    string_agg(format('r.%I = e.%I',a.attname,b.attname),' and ') as predicate
   from pg_catalog.pg_constraint c
   cross join lateral unnest(c.conkey,c.confkey) as keys(src,dst)
   join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=keys.src
   join pg_catalog.pg_attribute b on b.attrelid=c.confrelid and b.attnum=keys.dst
   where c.contype='f' and c.confrelid='public.employees'::regclass
   group by c.oid,c.conrelid
 loop
   execute format('select exists(select 1 from %s r join public.employees e on %s where e.organization_id=$1 and e.id=$2)',dep.relation,dep.predicate)
     into present using org,employee;
   if present then reasons:=reasons||jsonb_build_array(case dep.relation::text
     when 'public.shifts' then 'Draft schedule assignments must be preserved.'
     when 'public.published_shifts' then 'Published schedule assignments must be preserved.'
     when 'public.invitations' then 'Invitation history must be preserved.'
     when 'public.time_off_requests' then 'Time-off records must be preserved.'
     when 'public.employee_availability' then 'Availability records must be preserved.'
     when 'public.shift_requests' then 'Shift request history must be preserved.'
     when 'public.shift_request_responses' then 'Shift request responses must be preserved.'
     when 'public.employee_events' then 'Employee management audit history must be preserved.'
     else 'Other dependent business records must be preserved.' end); end if;
 end loop;
 if exists(select 1 from public.assignment_events where organization_id=org and
   (employee_id=employee or previous_employee_id=employee or
    before_snapshot->>'employee_id'=employee::text or after_snapshot->>'employee_id'=employee::text)) then
   reasons:=reasons||jsonb_build_array('Assignment audit history must be preserved.');
 end if;
 return reasons;
end $$;
revoke all on function shiftly_private.employee_delete_reasons(uuid,uuid) from public,anon,authenticated;

create function shiftly_private.employee_lifecycle(org uuid,employee uuid,command text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.employees; blockers jsonb:='[]'; reasons jsonb; item record;
begin
 if auth.uid() is null or coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Permission denied'; end if;
 if command is null or command not in ('inspect','archive','restore','delete') then raise exception 'Unknown employee action'; end if;
 perform 1 from public.organizations where id=org for no key update;
 if coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Permission denied'; end if;
 select * into e from public.employees where organization_id=org and id=employee for update;
 if e.id is null then raise exception 'Employee unavailable'; end if;
 if exists(select 1 from public.memberships where organization_id=org and user_id=e.user_id and role='owner') and
   (public.workspace_role_for(org)<>'owner' or (select count(*) from public.memberships where organization_id=org and role='owner')<=1) then
   blockers:=blockers||jsonb_build_array(jsonb_build_object('kind','owner','message','Only an owner can remove another owner, and at least one owner must remain.'));
 end if;
 for item in
   select 'draft' as kind,id,starts_at,ends_at from public.shifts where organization_id=org and employee_id=employee and ends_at>now()
   union all
   select 'published',id,starts_at,ends_at from public.published_shifts where organization_id=org and employee_id=employee and ends_at>now()
 loop
   blockers:=blockers||jsonb_build_array(jsonb_build_object('kind',item.kind,'id',item.id,'message',
     format('Resolve %s shift: %s – %s (UTC). Reassign coverage and publish the updated schedule.',item.kind,item.starts_at at time zone 'UTC',item.ends_at at time zone 'UTC')));
 end loop;
 for item in select id,kind from public.shift_requests where organization_id=org and status in ('open','pending') and
   (original_employee=employee or replacement_employee=employee or requester=e.user_id or accepted_by=e.user_id or
    exists(select 1 from public.shift_request_responses r where r.request_id=shift_requests.id and r.organization_id=org and r.employee_id=employee))
 loop
   blockers:=blockers||jsonb_build_array(jsonb_build_object('kind','request','id',item.id,'message','Resolve pending '||item.kind||' request '||item.id::text||' in Shift Requests.'));
 end loop;
 for item in select id from public.time_off_requests where organization_id=org and employee_id=employee and status='pending'
 loop
   blockers:=blockers||jsonb_build_array(jsonb_build_object('kind','time-off','id',item.id,'message','Review or cancel pending time-off request '||item.id::text||'.'));
 end loop;
 reasons:=shiftly_private.employee_delete_reasons(org,employee);
 if command='archive' then
   if e.archived_at is not null then raise exception 'Employee is already archived'; end if;
   if jsonb_array_length(blockers)>0 then return jsonb_build_object('ok',false,'blockers',blockers,'delete_reasons',reasons); end if;
   -- Lock order matches issue/accept invitation: organization, roster, invitations.
   update public.invitations set revoked_at=now() where organization_id=org and accepted_at is null and revoked_at is null
     and (employee_id=employee or (e.email is not null and email=e.email) or email in (select lower(u.email) from auth.users u where u.id=e.user_id));
   if e.user_id is not null then perform shiftly_private.remove_roster_membership(org,e.user_id); end if;
   update public.employees set archived_at=now(),archived_user_id=coalesce(user_id,archived_user_id),user_id=null where organization_id=org and id=employee;
   insert into public.employee_events(organization_id,employee_id,actor_id,action) values(org,employee,auth.uid(),'archive');
 elsif command='restore' then
   if e.archived_at is null then raise exception 'Employee is already active'; end if;
   update public.employees set archived_at=null where organization_id=org and id=employee;
   insert into public.employee_events(organization_id,employee_id,actor_id,action) values(org,employee,auth.uid(),'restore');
 elsif command='delete' then
   if jsonb_array_length(reasons)>0 then return jsonb_build_object('ok',false,'blockers',blockers,'delete_reasons',reasons); end if;
   delete from public.employees where organization_id=org and id=employee;
 end if;
 return jsonb_build_object('ok',true,'blockers',blockers,'delete_reasons',reasons);
end $$;
create function public.employee_lifecycle(org uuid,employee uuid,command text default 'inspect') returns jsonb
language sql security invoker set search_path='' as $$select shiftly_private.employee_lifecycle(org,employee,command)$$;
revoke all on function shiftly_private.employee_lifecycle(uuid,uuid,text),public.employee_lifecycle(uuid,uuid,text) from public,anon;
grant execute on function shiftly_private.employee_lifecycle(uuid,uuid,text),public.employee_lifecycle(uuid,uuid,text) to authenticated;

-- Protect assignment writes from all existing commands, including copy, publish,
-- multi-employee assignment and transfer approval. Historical rows remain readable.
create function shiftly_private.require_active_employee() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.employee_id is null then return new; end if;
 if tg_op='UPDATE' and tg_table_name<>'employee_availability' then
   if new.employee_id is not distinct from old.employee_id and new.starts_at is not distinct from old.starts_at
     and new.ends_at is not distinct from old.ends_at then return new; end if;
 end if;
 -- Republishing a mixed past/future week must preserve its archived historical assignments.
 if tg_table_name='published_shifts' then
 if new.ends_at<=now() and exists(
   select 1 from public.shifts s where s.organization_id=new.organization_id and s.id=new.id
     and s.employee_id=new.employee_id and s.starts_at=new.starts_at and s.ends_at=new.ends_at
 ) then return new; end if;
 end if;
 perform 1 from public.employees where organization_id=new.organization_id and id=new.employee_id and archived_at is null for share;
 if not found then raise exception 'Archived employees cannot receive new assignments or requests'; end if;
 return new;
end $$;
revoke all on function shiftly_private.require_active_employee() from public,anon,authenticated;
create trigger active_assignment before insert or update on public.shifts for each row execute function shiftly_private.require_active_employee();
create trigger active_publication before insert or update on public.published_shifts for each row execute function shiftly_private.require_active_employee();
create trigger active_time_off before insert or update on public.time_off_requests for each row execute function shiftly_private.require_active_employee();
create trigger active_availability before insert or update on public.employee_availability for each row execute function shiftly_private.require_active_employee();

-- Reject both invitation issuance and acceptance for archived roster identities.
create function shiftly_private.require_active_invitation() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.employee_id is not null and new.revoked_at is null then
   perform 1 from public.employees where organization_id=new.organization_id and id=new.employee_id and archived_at is null for share;
   if not found then raise exception 'Restore this employee before inviting or reconnecting'; end if;
 end if;
 return new;
end $$;
revoke all on function shiftly_private.require_active_invitation() from public,anon,authenticated;
create trigger active_roster_invitation before insert or update on public.invitations for each row execute function shiftly_private.require_active_invitation();
commit;
