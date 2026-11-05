-- Persistent limits work across Vercel instances. Revoked/failed sends still count.
create index invitations_actor_time_idx on public.invitations(created_by,created_at);
create index invitations_org_email_time_idx on public.invitations(organization_id,email,created_at);

-- Keep the privileged implementation outside the exposed public schema.
create schema if not exists shiftly_private;
revoke all on schema shiftly_private from public, anon;
grant usage on schema shiftly_private to authenticated;
create function shiftly_private.issue_invitation(org uuid, invite_email text,
 invite_role public.workspace_role, token_digest text, replaces uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; caller public.workspace_role; previous public.invitations;
 normalized_email text := lower(trim(invite_email));
begin
 caller := public.workspace_role_for(org);
 if auth.uid() is null or caller is null or caller not in ('owner','manager')
 or invite_role is null or invite_role='owner' or (caller='manager' and invite_role<>'employee') then
   raise exception 'Permission denied';
 end if;
 if token_digest is null or token_digest !~ '^[a-f0-9]{64}$'
 or normalized_email is null or length(normalized_email)>254
 or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
   raise exception 'Invalid invitation';
 end if;
 -- Serialize each actor across workspaces, then each organization across actors.
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
 perform 1 from public.organizations where id=org for no key update;
 -- Recheck authorization after waiting for locks.
 caller := public.workspace_role_for(org);
 if caller is null or caller not in ('owner','manager') or (caller='manager' and invite_role<>'employee') then
   raise exception 'Permission denied';
 end if;
 if replaces is not null then
   select * into previous from public.invitations where id=replaces and organization_id=org for update;
   if previous.id is null or previous.accepted_at is not null or previous.revoked_at is not null
   or previous.email<>normalized_email or previous.role<>invite_role then
     raise exception 'Invitation unavailable';
   end if;
 end if;
 if caller='manager' and exists(select 1 from public.invitations where organization_id=org
   and email=normalized_email and role='manager' and accepted_at is null and revoked_at is null) then
   raise exception 'Permission denied';
 end if;
 if (select count(*) from public.invitations where created_by=auth.uid() and created_at>now()-interval '1 hour')>=20
 or (select count(*) from public.invitations where organization_id=org and created_at>now()-interval '1 hour')>=50
 or exists(select 1 from public.invitations where organization_id=org and email=normalized_email and created_at>now()-interval '60 seconds') then
   raise exception 'Invitation rate limit exceeded';
 end if;
 -- Lock before invalidating so acceptance/resend races resolve to a single outcome.
 perform 1 from public.invitations where organization_id=org and email=normalized_email
   and accepted_at is null and revoked_at is null for update;
 update public.invitations set revoked_at=now() where organization_id=org and email=normalized_email
   and accepted_at is null and revoked_at is null;
 insert into public.invitations(organization_id,email,role,token_hash,created_by)
 values(org,normalized_email,invite_role,token_digest,auth.uid()) returning id into result;
 return result;
end $$;
create function public.issue_invitation(org uuid, invite_email text,
 invite_role public.workspace_role, token_digest text, replaces uuid default null) returns uuid
language sql security invoker set search_path = '' as $$
 select shiftly_private.issue_invitation(org,invite_email,invite_role,token_digest,replaces)
$$;
revoke execute on function shiftly_private.issue_invitation(uuid,text,public.workspace_role,text,uuid) from public,anon;
grant execute on function shiftly_private.issue_invitation(uuid,text,public.workspace_role,text,uuid) to authenticated;
-- The old RPC must not bypass the new persistent limits.
create or replace function public.invite_employee(org uuid, invite_email text,
 invite_role public.workspace_role, token_digest text) returns uuid
language sql security invoker set search_path = '' as $$
 select public.issue_invitation(org,invite_email,invite_role,token_digest,null)
$$;
revoke execute on function public.issue_invitation(uuid,text,public.workspace_role,text,uuid) from public,anon;
grant execute on function public.issue_invitation(uuid,text,public.workspace_role,text,uuid) to authenticated;
