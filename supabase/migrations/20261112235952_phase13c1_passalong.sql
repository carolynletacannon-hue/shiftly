-- Source: Meadowmark-connect PR #2, bf349f34510c20905452e5627729cf3a1362b283.
-- Workforce owns migration history. See docs/PASSALONG-MIGRATION.md.
-- Phase 13C1: individual accounts only. Does not enable Connect or seed grants.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create schema connect_private;
revoke all on schema connect_private from public, anon, authenticated;
create table connect_private.settings (
 organization_id uuid primary key references public.organizations,
 allow_own_edit boolean not null default true,
 allow_member_resolve boolean not null default true,
 allow_member_pin boolean not null default false,
 access_mode text not null default 'individual' check(access_mode='individual')
);
create table connect_private.categories (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations,
 name text not null check(length(trim(name)) between 1 and 40), active boolean not null default true,
 unique(organization_id,id), unique(organization_id,name)
);
create table connect_private.notes (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations,
 title text not null check(length(trim(title)) between 1 and 160),
 content text not null check(length(trim(content)) between 1 and 10000), category_id uuid,
 actor_account_id uuid not null references auth.users, claimed_author_employee_id uuid,
 author_name text not null, created_at timestamptz not null default clock_timestamp(),
 last_activity_at timestamptz not null default clock_timestamp(), resolved boolean not null default false,
 pinned boolean not null default false, revision integer not null default 1,
 unique(organization_id,id),
 foreign key(organization_id,category_id) references connect_private.categories(organization_id,id),
 foreign key(organization_id,claimed_author_employee_id) references public.employees(organization_id,id)
);
create index passalong_feed on connect_private.notes(organization_id,resolved,pinned desc,last_activity_at desc,id desc);
create index passalong_author on connect_private.notes(organization_id,actor_account_id,last_activity_at desc,id desc);
create table connect_private.comments (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, note_id uuid not null,
 content text not null check(length(trim(content)) between 1 and 4000),
 actor_account_id uuid not null references auth.users, claimed_author_employee_id uuid, author_name text not null,
 created_at timestamptz not null default clock_timestamp(), revision integer not null default 1,
 foreign key(organization_id,note_id) references connect_private.notes(organization_id,id),
 foreign key(organization_id,claimed_author_employee_id) references public.employees(organization_id,id)
);
create index passalong_comments on connect_private.comments(organization_id,note_id,created_at desc,id desc);
create table connect_private.history (
 id bigint generated always as identity primary key, organization_id uuid not null references public.organizations,
 actor_account_id uuid not null references auth.users, action text not null, entity_id uuid not null,
 before_value jsonb, after_value jsonb, occurred_at timestamptz not null default clock_timestamp()
);
create index passalong_history on connect_private.history(organization_id,occurred_at desc,id desc);
alter table connect_private.settings enable row level security;
alter table connect_private.categories enable row level security;
alter table connect_private.notes enable row level security;
alter table connect_private.comments enable row level security;
alter table connect_private.history enable row level security;
revoke all on all tables in schema connect_private from public,anon,authenticated;
revoke all on all sequences in schema connect_private from public,anon,authenticated;
-- Narrow privileged boundary: no table grants. The existing context checks live
-- membership, release, activation and explicit product grant on EVERY call.
create function connect_private.passalong(org uuid, command text, payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare ctx jsonb; cfg connect_private.settings; n connect_private.notes; c connect_private.comments;
 old_value jsonb; entity uuid; result jsonb; author text; manager boolean; stamp timestamptz;
 off integer; cat uuid;
begin
 if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
  raise exception 'Connect access denied' using errcode='42501'; end if;
 ctx:=shiftly_private.connect_context_v1(org);
 manager:=ctx->>'role'='moderator';
 select * into cfg from connect_private.settings where organization_id=org;
 if cfg.organization_id is null then cfg.allow_own_edit:=true;cfg.allow_member_resolve:=true;cfg.allow_member_pin:=false; end if;
 if command='feed' then
  off:=greatest(0,least(coalesce((payload->>'offset')::integer,0),10000));
  select jsonb_build_object('notes',coalesce(jsonb_agg(x),'[]'::jsonb),'settings',jsonb_build_object(
   'allow_own_edit',cfg.allow_own_edit,'allow_member_resolve',cfg.allow_member_resolve,'allow_member_pin',cfg.allow_member_pin,'access_mode','individual'),
   'authors',(select coalesce(jsonb_agg(a order by a.name,a.id),'[]'::jsonb) from (select distinct on (actor_account_id) actor_account_id id,author_name name from connect_private.notes where organization_id=org order by actor_account_id,last_activity_at desc,id desc) a),
   'categories',(select coalesce(jsonb_agg(k order by k.name,k.id),'[]'::jsonb) from connect_private.categories k where k.organization_id=org)) into result
  from (select t.*,
   (select count(*) from connect_private.comments cm where cm.organization_id=org and cm.note_id=t.id) comment_count,
   (select jsonb_build_object('content',cm.content,'author_name',cm.author_name,'created_at',cm.created_at) from connect_private.comments cm where cm.organization_id=org and cm.note_id=t.id order by cm.created_at desc,cm.id desc limit 1) newest_comment
   from connect_private.notes t where t.organization_id=org and t.resolved=coalesce((payload->>'resolved')::boolean,false)
    and (coalesce(payload->>'search','')='' or position(lower(left(payload->>'search',160)) in lower(t.title||' '||t.content))>0)
    and (nullif(payload->>'category','') is null or t.category_id=(payload->>'category')::uuid)
    and (nullif(payload->>'author','') is null or t.actor_account_id=(payload->>'author')::uuid)
   order by t.pinned desc,t.last_activity_at desc,t.id desc limit 25 offset off) x;
  return result;
 elsif command='comments' then
  if not exists(select 1 from connect_private.notes where organization_id=org and id=(payload->>'note_id')::uuid) then raise exception 'Note unavailable';end if;
  return (select coalesce(jsonb_agg(x order by x.created_at,x.id),'[]'::jsonb) from
   (select * from connect_private.comments where organization_id=org and note_id=(payload->>'note_id')::uuid
    order by created_at desc,id desc limit 50 offset greatest(0,least(coalesce((payload->>'offset')::integer,0),10000))) x);
 elsif command in ('settings','category') then
  if not manager then raise exception 'Connect manager required' using errcode='42501';end if;
  if command='settings' then
   if coalesce(payload->>'access_mode','individual')<>'individual' then raise exception 'Workstation access is not available in this phase';end if;
   old_value:=to_jsonb(cfg);
   insert into connect_private.settings(organization_id,allow_own_edit,allow_member_resolve,allow_member_pin)
    values(org,(payload->>'allow_own_edit')::boolean,(payload->>'allow_member_resolve')::boolean,(payload->>'allow_member_pin')::boolean)
    on conflict(organization_id) do update set allow_own_edit=excluded.allow_own_edit,allow_member_resolve=excluded.allow_member_resolve,allow_member_pin=excluded.allow_member_pin
    returning to_jsonb(settings.*) into result;
   entity:=org;
  else
   entity:=nullif(payload->>'id','')::uuid;
   if entity is null then
    insert into connect_private.categories(organization_id,name) values(org,trim(payload->>'name')) returning id,to_jsonb(categories.*) into entity,result;
   else
    select to_jsonb(k) into old_value from connect_private.categories k where organization_id=org and id=entity for update;
    if old_value is null then raise exception 'Category unavailable';end if;
    update connect_private.categories set name=trim(payload->>'name'),active=(payload->>'active')::boolean where organization_id=org and id=entity returning to_jsonb(categories.*) into result;
   end if;
  end if;
 else
  -- Employee identity and displayed name are derived, never supplied by the client.
  select d.display_name into author from shiftly_private.connect_directory_v1(org) d where d.employee_id=(ctx->>'employee_id')::uuid;
  author:=coalesce(author,'Workplace member');
  cat:=nullif(payload->>'category_id','')::uuid;
  if cat is not null and not exists(select 1 from connect_private.categories where organization_id=org and id=cat and (active or exists(select 1 from connect_private.notes t where t.organization_id=org and t.id=(payload->>'note_id')::uuid and t.category_id=cat))) then raise exception 'Category unavailable';end if;
  if command='create' then
   stamp:=clock_timestamp();
   insert into connect_private.notes(organization_id,title,content,category_id,actor_account_id,claimed_author_employee_id,author_name,created_at,last_activity_at)
    values(org,trim(payload->>'title'),trim(payload->>'content'),cat,auth.uid(),(ctx->>'employee_id')::uuid,author,stamp,stamp)
    returning id,to_jsonb(notes.*) into entity,result;
  else
   select * into n from connect_private.notes where organization_id=org and id=(payload->>'note_id')::uuid for update;
   if n.id is null then raise exception 'Note unavailable';end if;
   stamp:=clock_timestamp();entity:=n.id;old_value:=to_jsonb(n);
   if command='comment' then
    insert into connect_private.comments(organization_id,note_id,content,actor_account_id,claimed_author_employee_id,author_name,created_at)
     values(org,n.id,trim(payload->>'content'),auth.uid(),(ctx->>'employee_id')::uuid,author,stamp)
     returning id,to_jsonb(comments.*) into entity,result;
    old_value:=null;
    update connect_private.notes set last_activity_at=stamp where organization_id=org and id=n.id;
   elsif command='edit_comment' then
    select * into c from connect_private.comments where organization_id=org and note_id=n.id and id=(payload->>'comment_id')::uuid for update;
    if c.id is null or c.actor_account_id<>auth.uid() or not cfg.allow_own_edit then raise exception 'Edit not permitted' using errcode='42501';end if;
    if c.revision is distinct from (payload->>'revision')::integer then raise exception 'This comment changed. Refresh before editing.' using errcode='40001';end if;
    entity:=c.id;old_value:=to_jsonb(c);
    update connect_private.comments set content=trim(payload->>'content'),revision=revision+1 where id=c.id returning to_jsonb(comments.*) into result;
    update connect_private.notes set last_activity_at=stamp where organization_id=org and id=n.id;
   else
    if n.revision is distinct from (payload->>'revision')::integer then raise exception 'This note changed. Refresh before editing.' using errcode='40001';end if;
    if command='edit' then
     if n.actor_account_id<>auth.uid() or not cfg.allow_own_edit then raise exception 'Edit not permitted' using errcode='42501';end if;
     update connect_private.notes set title=trim(payload->>'title'),content=trim(payload->>'content'),category_id=cat,revision=revision+1,last_activity_at=stamp where id=n.id returning to_jsonb(notes.*) into result;
    elsif command='resolve' then
     if not manager and not cfg.allow_member_resolve then raise exception 'Resolve not permitted' using errcode='42501';end if;
     update connect_private.notes set resolved=(payload->>'resolved')::boolean,revision=revision+1,last_activity_at=stamp where id=n.id returning to_jsonb(notes.*) into result;
    elsif command='pin' then
     if not manager and not cfg.allow_member_pin then raise exception 'Pin not permitted' using errcode='42501';end if;
     update connect_private.notes set pinned=(payload->>'pinned')::boolean,revision=revision+1,last_activity_at=stamp where id=n.id returning to_jsonb(notes.*) into result;
    else raise exception 'Unknown Passalong command';end if;
   end if;
  end if;
 end if;
 insert into connect_private.history(organization_id,actor_account_id,action,entity_id,before_value,after_value)
  values(org,auth.uid(),command,entity,old_value,result);
 return result;
end $$;
create function public.connect_passalong_v1(org uuid,command text,payload jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select connect_private.passalong(org,command,payload) $$;
revoke all on function connect_private.passalong(uuid,text,jsonb),public.connect_passalong_v1(uuid,text,jsonb) from public,anon,authenticated;
grant usage on schema connect_private to authenticated;
grant execute on function connect_private.passalong(uuid,text,jsonb),public.connect_passalong_v1(uuid,text,jsonb) to authenticated;
commit;
