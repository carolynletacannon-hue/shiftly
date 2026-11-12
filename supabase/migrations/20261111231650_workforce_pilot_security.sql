begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Preserve function OIDs, trigger bindings and existing policy dependencies.
-- Only the public, security-invoker compatibility entrypoints are exposed as RPCs.
alter function public.bootstrap_profile() set schema shiftly_private;
revoke all on function shiftly_private.bootstrap_profile() from public,anon,authenticated;
alter function public.workspace_role_for(uuid) set schema shiftly_private;
alter function public.create_workspace(text,text) set schema shiftly_private;
alter function public.change_member_role(uuid,uuid,public.workspace_role) set schema shiftly_private;
alter function public.revoke_invitation(uuid) set schema shiftly_private;

create function public.workspace_role_for(org uuid) returns public.workspace_role
language sql stable security invoker set search_path='' as $$
 select shiftly_private.workspace_role_for(org)
$$;
create function public.create_workspace(workspace_name text,workspace_timezone text) returns uuid
language sql security invoker set search_path='' as $$
 select shiftly_private.create_workspace(workspace_name,workspace_timezone)
$$;
create function public.change_member_role(org uuid,member_id uuid,new_role public.workspace_role) returns void
language sql security invoker set search_path='' as $$
 select shiftly_private.change_member_role(org,member_id,new_role)
$$;
create function public.revoke_invitation(invitation_id uuid) returns void
language sql security invoker set search_path='' as $$
 select shiftly_private.revoke_invitation(invitation_id)
$$;

-- Explicit grants also cover projects with Supabase's automatic function grants.
revoke all on function
 shiftly_private.workspace_role_for(uuid),public.workspace_role_for(uuid),
 shiftly_private.create_workspace(text,text),public.create_workspace(text,text),
 shiftly_private.change_member_role(uuid,uuid,public.workspace_role),public.change_member_role(uuid,uuid,public.workspace_role),
 shiftly_private.revoke_invitation(uuid),public.revoke_invitation(uuid)
 from public,anon,authenticated;
grant execute on function
 shiftly_private.workspace_role_for(uuid),public.workspace_role_for(uuid),
 shiftly_private.create_workspace(text,text),public.create_workspace(text,text),
 shiftly_private.change_member_role(uuid,uuid,public.workspace_role),public.change_member_role(uuid,uuid,public.workspace_role),
 shiftly_private.revoke_invitation(uuid),public.revoke_invitation(uuid)
 to authenticated;

-- Intentionally no policies: client access remains deny-all. Owners/checked
-- SECURITY DEFINER workers retain access. This snapshot previously relied on ACLs.
alter table shiftly_private.notification_schedule_snapshots enable row level security;
revoke all on shiftly_private.notification_schedule_snapshots from public,anon,authenticated;
commit;
