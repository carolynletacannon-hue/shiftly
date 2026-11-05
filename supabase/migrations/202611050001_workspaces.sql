-- All privileged functions use a fixed search path and the caller's verified auth.uid().
create type public.workspace_role as enum ('owner','manager','employee');
create table public.profiles (
 id uuid primary key references auth.users on delete cascade,
 display_name text not null default '' check (length(display_name) <= 100)
);
create table public.organizations (
 id uuid primary key default gen_random_uuid(),
 name text not null check (length(trim(name)) between 1 and 100),
 timezone text not null default 'America/Denver',
 settings jsonb not null default '{"week_starts_on":0}' check (jsonb_typeof(settings) = 'object'),
 created_at timestamptz not null default now()
);
create table public.memberships (
 organization_id uuid not null references public.organizations on delete cascade,
 user_id uuid not null references public.profiles on delete cascade,
 role public.workspace_role not null default 'employee',
 primary key (organization_id,user_id)
);
create index memberships_user_idx on public.memberships(user_id);
create table public.positions (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations on delete cascade,
 name text not null check (length(trim(name)) between 1 and 100),
 unique (organization_id,name)
);
create table public.invitations (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations on delete cascade,
 email text not null check (email = lower(trim(email)) and email like '%@%'),
 role public.workspace_role not null check (role <> 'owner'),
 token_hash text not null unique,
 expires_at timestamptz not null default now() + interval '7 days',
 accepted_at timestamptz,
 revoked_at timestamptz,
 created_by uuid not null references public.profiles,
 created_at timestamptz not null default now()
);
create index invitations_org_idx on public.invitations(organization_id);
create function public.workspace_role_for(org uuid) returns public.workspace_role
language sql stable security definer set search_path = '' as $$
 select role from public.memberships where organization_id=org and user_id=auth.uid()
$$;
create function public.bootstrap_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 insert into public.profiles(id,display_name) values(new.id,left(coalesce(new.raw_user_meta_data->>'display_name',''),100));
 return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.bootstrap_profile();
insert into public.profiles(id) select id from auth.users on conflict do nothing;
create function public.validate_timezone() returns trigger language plpgsql set search_path = '' as $$
begin
 if not exists(select 1 from pg_timezone_names where name=new.timezone) then raise exception 'Invalid timezone'; end if;
 return new;
end $$;
create trigger valid_timezone before insert or update on public.organizations for each row execute function public.validate_timezone();
alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.positions enable row level security;
alter table public.invitations enable row level security;
create policy profiles_read on public.profiles for select to authenticated using (id=auth.uid() or exists (
 select 1 from public.memberships m where m.user_id=profiles.id and public.workspace_role_for(m.organization_id) is not null));
create policy profiles_update on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
create policy org_read on public.organizations for select to authenticated using(public.workspace_role_for(id) is not null);
create policy org_update on public.organizations for update to authenticated using(public.workspace_role_for(id)='owner') with check(public.workspace_role_for(id)='owner');
create policy members_read on public.memberships for select to authenticated using(public.workspace_role_for(organization_id) is not null);
create policy positions_read on public.positions for select to authenticated using(public.workspace_role_for(organization_id) is not null);
create policy positions_write on public.positions for all to authenticated using(public.workspace_role_for(organization_id) in ('owner','manager')) with check(public.workspace_role_for(organization_id) in ('owner','manager'));
-- Invitation hashes are never exposed, even to workspace administrators.
create policy invitations_read on public.invitations for select to authenticated using(public.workspace_role_for(organization_id) in ('owner','manager'));
revoke all on public.profiles,public.organizations,public.memberships,public.positions,public.invitations from anon,authenticated;
grant select,update(display_name) on public.profiles to authenticated;
grant select,update(name,timezone,settings) on public.organizations to authenticated;
grant select on public.memberships to authenticated;
grant select,insert,update,delete on public.positions to authenticated;
grant select(id,organization_id,email,role,expires_at,accepted_at,revoked_at,created_at,created_by) on public.invitations to authenticated;
create function public.create_workspace(workspace_name text, workspace_timezone text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare org uuid;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 insert into public.organizations(name,timezone) values(trim(workspace_name),workspace_timezone) returning id into org;
 insert into public.memberships values(org,auth.uid(),'owner');
 return org;
end $$;
create function public.invite_employee(org uuid, invite_email text, invite_role public.workspace_role, token_digest text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; caller public.workspace_role;
begin
 caller := public.workspace_role_for(org);
 if caller is null or caller not in ('owner','manager') or invite_role='owner' or (caller='manager' and invite_role<>'employee') then raise exception 'Permission denied'; end if;
 if token_digest !~ '^[a-f0-9]{64}$' then raise exception 'Invalid token digest'; end if;
 insert into public.invitations(organization_id,email,role,token_hash,created_by) values(org,lower(trim(invite_email)),invite_role,token_digest,auth.uid()) returning id into result;
 return result;
end $$;
create function public.accept_invitation(token_digest text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare invitation public.invitations; verified_email text;
begin
 select lower(email) into verified_email from auth.users where id=auth.uid() and email_confirmed_at is not null;
 if verified_email is null then raise exception 'Verify your email before accepting'; end if;
 select * into invitation from public.invitations where token_hash=token_digest for update;
 if invitation.id is null or invitation.accepted_at is not null or invitation.revoked_at is not null or invitation.expires_at<=now() or invitation.email<>verified_email then raise exception 'Invitation invalid or expired'; end if;
 -- Existing members retain their role; invitations cannot promote them.
 insert into public.memberships values(invitation.organization_id,auth.uid(),invitation.role) on conflict do nothing;
 update public.invitations set accepted_at=now() where id=invitation.id;
 return invitation.organization_id;
end $$;
create function public.revoke_invitation(invitation_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
 update public.invitations set revoked_at=now() where id=invitation_id and public.workspace_role_for(organization_id) in ('owner','manager') and accepted_at is null;
 if not found then raise exception 'Permission denied or invitation unavailable'; end if;
end $$;
create function public.change_member_role(org uuid, member_id uuid, new_role public.workspace_role) returns void
language plpgsql security definer set search_path = '' as $$
begin
 -- Owner assignment/transfer is intentionally excluded from Phase 1.
 if public.workspace_role_for(org) is distinct from 'owner' or member_id=auth.uid() or new_role='owner' then raise exception 'Permission denied'; end if;
 update public.memberships set role=new_role where organization_id=org and user_id=member_id and role<>'owner';
 if not found then raise exception 'Member unavailable'; end if;
end $$;
revoke execute on function public.workspace_role_for(uuid),public.bootstrap_profile(),public.validate_timezone(),public.create_workspace(text,text),public.invite_employee(uuid,text,public.workspace_role,text),public.accept_invitation(text),public.revoke_invitation(uuid),public.change_member_role(uuid,uuid,public.workspace_role) from public,anon;
grant execute on function public.workspace_role_for(uuid),public.create_workspace(text,text),public.invite_employee(uuid,text,public.workspace_role,text),public.accept_invitation(text),public.revoke_invitation(uuid),public.change_member_role(uuid,uuid,public.workspace_role) to authenticated;
