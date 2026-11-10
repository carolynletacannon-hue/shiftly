begin;
-- No existing identity, Workforce grant, policy, or record is modified.
create table public.product_releases (
 product_id text primary key check(product_id = 'connect'),
 available boolean not null default false
);
insert into public.product_releases values ('connect', false);
create table public.organization_products (
 organization_id uuid not null references public.organizations on delete cascade,
 product_id text not null references public.product_releases,
 state text not null default 'inactive' check(state in ('inactive','active','suspended')),
 primary key(organization_id,product_id)
);
create table public.product_memberships (
 organization_id uuid not null,
 user_id uuid not null,
 product_id text not null check(product_id = 'connect'),
 role text not null check(role in ('member','moderator')),
 primary key(organization_id,user_id,product_id),
 foreign key(organization_id,user_id) references public.memberships on delete cascade,
 foreign key(organization_id,product_id) references public.organization_products on delete cascade
);
create index product_memberships_user_idx on public.product_memberships(user_id,organization_id,product_id);
alter table public.product_releases enable row level security;
alter table public.organization_products enable row level security;
alter table public.product_memberships enable row level security;
revoke all on public.product_releases, public.organization_products, public.product_memberships from public,anon,authenticated;
grant select on public.product_releases, public.organization_products, public.product_memberships to authenticated;
create policy release_read on public.product_releases for select to authenticated using (auth.uid() is not null);
create policy activation_read on public.organization_products for select to authenticated
 using(public.workspace_role_for(organization_id) is not null);
create policy own_product_grant_read on public.product_memberships for select to authenticated
 using(user_id = (select auth.uid()) and public.workspace_role_for(organization_id) is not null);
-- Provisioning is deliberately trusted-operator SQL only. No browser write grants,
-- role inheritance, auto-activation, or grant administration endpoints.
create function shiftly_private.connect_context_v1(org uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null then raise exception 'Connect access denied' using errcode='42501'; end if;
 select jsonb_build_object('version','1','account_id',m.user_id,
   'organization_id',o.id,'organization_name',o.name,'timezone',o.timezone,
   'employee_id',e.id,'role',pm.role)
 into result
 from public.memberships m
 join public.organizations o on o.id=m.organization_id
 join public.product_memberships pm on pm.organization_id=m.organization_id and pm.user_id=m.user_id and pm.product_id='connect'
 join public.organization_products op on op.organization_id=pm.organization_id and op.product_id=pm.product_id and op.state='active'
 join public.product_releases pr on pr.product_id=pm.product_id and pr.available
 left join public.employees e on e.organization_id=m.organization_id and e.user_id=m.user_id and e.archived_at is null
 where m.organization_id=org and m.user_id=auth.uid();
 if result is null then raise exception 'Connect access denied' using errcode='42501'; end if;
 return result;
end $$;
create function public.connect_context_v1(org uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select shiftly_private.connect_context_v1(org) $$;
-- Definer is required to project the safe allowlist without broad employee grants.
-- Every entry point rechecks the caller's live authorization; no client user IDs.
create function shiftly_private.connect_directory_v1(org uuid)
returns table(organization_id uuid,employee_id uuid,display_name text)
language plpgsql stable security definer set search_path='' as $$
begin
 perform shiftly_private.connect_context_v1(org);
 return query select e.organization_id,e.id,e.display_name from public.employees e
 where e.organization_id=org and e.archived_at is null order by e.id;
end $$;
create function public.connect_directory_v1(org uuid)
returns table(organization_id uuid,employee_id uuid,display_name text)
language sql stable security invoker set search_path='' as $$ select * from shiftly_private.connect_directory_v1(org) $$;
revoke all on function shiftly_private.connect_context_v1(uuid), public.connect_context_v1(uuid),
 shiftly_private.connect_directory_v1(uuid),public.connect_directory_v1(uuid) from public,anon,authenticated;
grant usage on schema shiftly_private to authenticated;
grant execute on function shiftly_private.connect_context_v1(uuid), public.connect_context_v1(uuid),
 shiftly_private.connect_directory_v1(uuid),public.connect_directory_v1(uuid) to authenticated;
commit;
