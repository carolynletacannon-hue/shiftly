begin;
-- Lineage is a hint for stable matching of otherwise identical shared shifts.
-- No FK: deleting a source shift later must never affect copied weeks.
alter table public.shift_groups add column copy_source_group uuid;
create table public.schedule_copy_audits (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations,
 schedule_id uuid not null, source_id uuid not null, actor_id uuid not null references public.profiles,
 created_at timestamptz not null default now(), mode text not null, strategy text not null,
 previous_draft jsonb not null, revision integer not null,
 foreign key(organization_id,schedule_id) references public.schedules(organization_id,id),
 foreign key(organization_id,source_id) references public.schedules(organization_id,id)
);
create index schedule_copy_audits_source on public.schedule_copy_audits(organization_id,source_id);
create index schedule_copy_audits_actor on public.schedule_copy_audits(actor_id);
create index schedule_copy_audits_org on public.schedule_copy_audits(organization_id,schedule_id);
alter table public.schedule_copy_audits enable row level security;
create policy copy_audits_manager on public.schedule_copy_audits for select to authenticated
 using(public.workspace_role_for(organization_id) in ('owner','manager'));
revoke all on public.schedule_copy_audits from public,anon,authenticated;
grant select on public.schedule_copy_audits to authenticated;
-- Reject nonexistent and ambiguous wall times rather than silently moving shifts.
create function shiftly_private.copy_week_instant(value timestamptz,days integer,source_tz text,target_tz text) returns timestamptz
language plpgsql security invoker set search_path='' as $$
declare wall timestamp; result timestamptz; delta integer;
begin
 wall:=(value at time zone source_tz)+make_interval(days=>days);
 result:=wall at time zone target_tz;
 if result at time zone target_tz<>wall then raise exception 'Copy blocked: a shift falls in a skipped daylight-saving hour. Adjust the source time'; end if;
 foreach delta in array array[-120,-60,-30,30,60,120] loop
 if (result+make_interval(mins=>delta)) at time zone target_tz=wall then
 raise exception 'Copy blocked: a shift falls in a repeated daylight-saving hour. Adjust the source time before copying'; end if;
 end loop;
 return result;
end $$;
revoke all on function shiftly_private.copy_week_instant(timestamptz,integer,text,text) from public,anon,authenticated;
create function shiftly_private.copy_schedule_week(
 org uuid,source_week date,destination_week date,copy_mode text,strategy text,preview_token text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 src public.schedules; dst public.schedules; x public.shifts; source_group public.shift_groups; destination_group public.shift_groups; target_group uuid; group_used uuid[]:='{}'; matched uuid; assignee uuid; is_new boolean; ordinal integer; org_tz text;
 used uuid[]:='{}'; lo timestamptz; hi timestamptz; tz text; token text; before_draft jsonb;
 result jsonb; warnings jsonb:='[]'; added integer:=0; assigned integer:=0; skipped integer:=0; removed integer:=0;
begin
 if auth.uid() is null or coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Schedule permission denied'; end if;
 perform 1 from public.organizations where id=org for no key update;
 if coalesce(public.workspace_role_for(org)::text,'') not in ('owner','manager') then raise exception 'Schedule permission denied'; end if;
 if source_week is null or destination_week is null or source_week=destination_week or (destination_week-source_week)%7<>0 then
 raise exception 'Copy blocked: choose different weeks separated by whole calendar weeks'; end if;
 if copy_mode is null or copy_mode not in ('all','structure','assignments') or strategy is null or strategy not in ('merge','replace') then raise exception 'Copy blocked: choose a copy mode and draft strategy'; end if;
 if copy_mode='assignments' and strategy='replace' then raise exception 'Copy blocked: assignments only requires merge'; end if;
 select * into src from public.schedules where organization_id=org and week_start=source_week for update;
 if src.id is null then raise exception 'Copy blocked: source week has no saved schedule. Select another week'; end if;
 select * into dst from public.schedules where organization_id=org and week_start=destination_week for update;
 if dst.id is null and copy_mode='assignments' then raise exception 'Copy blocked: create destination shifts before copying assignments'; end if;
 select timezone into tz from public.organizations where id=org;
 org_tz:=tz;
 tz:=coalesce(dst.timezone,tz);
 if dst.id is null and extract(dow from destination_week)::integer<>(select coalesce((settings->>'week_starts_on')::integer,0) from public.organizations where id=org) then raise exception 'Copy blocked: choose the workspace week start'; end if;
 select jsonb_build_object('schedule',to_jsonb(dst),'groups',(select jsonb_agg(to_jsonb(g) order by g.id) from public.shift_groups g where g.schedule_id=dst.id),'shifts',coalesce(jsonb_agg(to_jsonb(s) order by s.id) filter(where s.id is not null),'[]'))
 into before_draft from public.shifts s where s.schedule_id=dst.id;
 -- Token binds options and every scheduling input; any intervening edit forces a new preview.
 select md5(jsonb_build_object('source',src,'destination',before_draft,'mode',copy_mode,'strategy',strategy,
 'shifts',(select jsonb_agg(to_jsonb(s) order by s.id) from public.shifts s where s.organization_id=org),
 'published',(select jsonb_agg(to_jsonb(s) order by s.id) from public.published_shifts s where s.organization_id=org),
 'employees',(select jsonb_agg(to_jsonb(e) order by e.id) from public.employees e where e.organization_id=org),
 'groups',(select jsonb_agg(to_jsonb(g) order by g.id) from public.shift_groups g where g.organization_id=org),
 'time_off',(select jsonb_agg(to_jsonb(c) order by c.id) from public.time_off_requests c where c.organization_id=org),
 'availability',(select jsonb_agg(to_jsonb(c) order by c.employee_id,c.weekday) from public.employee_availability c where c.organization_id=org),
 'settings',(select to_jsonb(c) from public.schedule_settings c where c.organization_id=org),
 'timezone',tz,'organization_timezone',org_tz,'week',destination_week)::text) into token;
 if preview_token is not null and preview_token<>token then raise exception 'Stale revision. Preview again: the schedule or employee constraints changed'; end if;
 -- Preview runs exactly the commit path in a subtransaction, then rolls it back.
 begin
 if dst.id is null then
 insert into public.schedules(organization_id,week_start,timezone,created_by)
 values(org,destination_week,tz,auth.uid()) returning * into dst;
 end if;
 if strategy='replace' then
 delete from public.shifts where schedule_id=dst.id;
 get diagnostics removed=row_count;
 end if;
 -- Orphaned historical group identities remain available for snapshots and requests.
 for source_group in select g.* from public.shift_groups g where g.schedule_id=src.id
 and exists(select 1 from public.shifts a where a.shift_group_id=g.id) order by g.starts_at,g.id loop
 lo:=shiftly_private.copy_week_instant(source_group.starts_at,destination_week-source_week,src.timezone,tz);
 hi:=shiftly_private.copy_week_instant(source_group.ends_at,destination_week-source_week,src.timezone,tz);
 target_group:=null;
 if strategy='merge' then
 select d.id into target_group from public.shift_groups d where d.schedule_id=dst.id and not(d.id=any(group_used))
 and exists(select 1 from public.shifts a where a.shift_group_id=d.id)
 and d.starts_at=lo and d.ends_at=hi and d.label=source_group.label and d.position_id is not distinct from source_group.position_id
 and (copy_mode='assignments' or (d.notes=source_group.notes and d.is_required=source_group.is_required and d.template_id is not distinct from source_group.template_id
 and d.required_count=source_group.required_count and d.allow_overstaffing=source_group.allow_overstaffing))
 order by (d.copy_source_group=source_group.id) desc nulls last,
 (select count(*) from public.shifts a join public.shifts b on a.employee_id=b.employee_id where a.shift_group_id=d.id and b.shift_group_id=source_group.id) desc,d.id limit 1;
 end if;
 is_new:=target_group is null;
 if is_new then
 if copy_mode='assignments' then
 warnings:=warnings||jsonb_build_array(jsonb_build_object('message','No matching destination shift; assignments skipped','label',source_group.label));
 skipped:=skipped+(select count(*) from public.shifts where shift_group_id=source_group.id and employee_id is not null); continue;
 end if;
 insert into public.shift_groups(organization_id,schedule_id,position_id,starts_at,ends_at,notes,label,requirement_id,template_id,is_required,required_count,allow_overstaffing,copy_source_group)
 values(org,dst.id,source_group.position_id,lo,hi,source_group.notes,source_group.label,source_group.requirement_id,source_group.template_id,source_group.is_required,source_group.required_count,source_group.allow_overstaffing,source_group.id)
 returning id into target_group;
 end if;
 select * into strict destination_group from public.shift_groups where id=target_group;
 group_used:=array_append(group_used,target_group);
 for x in select * from public.shifts where shift_group_id=source_group.id order by (employee_id is null),slot_ordinal,id loop
 assignee:=case when copy_mode='structure' then null else x.employee_id end;
 if assignee is not null and exists(select 1 from public.employees where organization_id=org and id=assignee and archived_at is not null) then
 warnings:=warnings||jsonb_build_array(jsonb_build_object('message','Archived employee skipped','employee_id',assignee,'label',source_group.label));
 assignee:=null; skipped:=skipped+1;
 end if;
 matched:=null;
 select d.id into matched from public.shifts d where d.shift_group_id=target_group and not(d.id=any(used))
 order by (d.employee_id is not distinct from assignee) desc,(d.employee_id is null) desc,d.id limit 1;
 if matched is not null and assignee is not null and exists(select 1 from public.shifts where id=matched and employee_id is not null and employee_id<>assignee) then
 -- Keep all destination employees. Add a person only if the existing shift policy permits it.
 matched:=null;
 end if;
 if matched is null then
 if not is_new and assignee is not null and exists(select 1 from public.shift_groups d where d.id=target_group and not d.allow_overstaffing
 and (select count(*) from public.shifts where shift_group_id=target_group and employee_id is not null)>=d.required_count) then
 warnings:=warnings||jsonb_build_array(jsonb_build_object('message','Destination shift is full; assignment skipped. Review staffing or enable overstaffing','employee_id',assignee,'label',source_group.label)); skipped:=skipped+1; continue;
 end if;
 if copy_mode='assignments' and assignee is null then continue; end if;
 select coalesce(max(slot_ordinal),0)+1 into ordinal from public.shifts where schedule_id=dst.id and requirement_id is not distinct from destination_group.requirement_id;
 insert into public.shifts(organization_id,schedule_id,shift_group_id,employee_id,position_id,starts_at,ends_at,notes,label,requirement_id,template_id,slot_ordinal,is_required,slot_kind)
 values(org,dst.id,target_group,null,destination_group.position_id,destination_group.starts_at,destination_group.ends_at,destination_group.notes,destination_group.label,destination_group.requirement_id,destination_group.template_id,ordinal,destination_group.is_required,case when destination_group.is_required then 'requirement' else 'one_off' end)
 returning id into matched;
 added:=added+1;
 end if;
 used:=array_append(used,matched);
 if assignee is not null and not exists(select 1 from public.shifts where id=matched and employee_id=assignee) then
 update public.shifts set employee_id=assignee where id=matched; assigned:=assigned+1;
 end if;
 end loop;
 end loop;
 if (select count(*) from public.shifts where schedule_id=dst.id)>300 then raise exception 'Copy blocked: weekly shift limit of 300 exceeded'; end if;
 perform shiftly_private.validate_schedule(dst.id);
 result:=jsonb_build_object('token',token,'timezone',tz,'organization_timezone',org_tz,'week',destination_week,'added',added,'assigned',assigned,'removed',removed,'skipped',skipped,'warnings',warnings,
 'employee_names',(select jsonb_object_agg(e.id,e.display_name) from public.employees e where e.organization_id=org),'availability_timezone',org_tz,'availability',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from public.employee_availability a where a.organization_id=org),
 'published',dst.published_revision is not null,'source_revision',src.revision,'destination_revision',dst.revision,
 'shifts',(select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('required_count',g.required_count,'allow_overstaffing',g.allow_overstaffing) order by s.starts_at,s.id),'[]') from public.shifts s join public.shift_groups g on g.id=s.shift_group_id where s.schedule_id=dst.id),
 'hours',(select coalesce(jsonb_agg(to_jsonb(h)),'[]') from (select e.id,e.display_name,round(sum(extract(epoch from (least(s.ends_at,(destination_week+7)::timestamp at time zone tz)-greatest(s.starts_at,destination_week::timestamp at time zone tz))))/3600,2) hours
 from public.employees e join public.shifts s on s.organization_id=e.organization_id and s.employee_id=e.id
 where e.organization_id=org and s.starts_at<((destination_week+7)::timestamp at time zone tz) and s.ends_at>(destination_week::timestamp at time zone tz)
 group by e.id,e.display_name) h));
 if preview_token is null then raise exception using errcode='P0002',message='preview rollback'; end if;
 update public.schedules set revision=revision+1,updated_at=now() where id=dst.id;
 insert into public.schedule_changes(organization_id,schedule_id,revision,command,payload,actor_id)
 values(org,dst.id,dst.revision+1,'week.copy',jsonb_build_object('source_week',source_week,'mode',copy_mode,'strategy',strategy),auth.uid());
 insert into public.schedule_copy_audits(organization_id,schedule_id,source_id,actor_id,mode,strategy,previous_draft,revision)
 values(org,dst.id,src.id,auth.uid(),copy_mode,strategy,before_draft,dst.revision+1);
 exception when sqlstate 'P0002' then
 if sqlerrm<>'preview rollback' then raise; end if;
 end;
 return result;
end $$;
create function public.copy_schedule_week(org uuid,source_week date,destination_week date,copy_mode text,strategy text,preview_token text default null)
returns jsonb language sql security invoker set search_path='' as $$
 select shiftly_private.copy_schedule_week(org,source_week,destination_week,copy_mode,strategy,preview_token)
$$;
revoke all on function shiftly_private.copy_schedule_week(uuid,date,date,text,text,text),public.copy_schedule_week(uuid,date,date,text,text,text) from public,anon;
grant execute on function shiftly_private.copy_schedule_week(uuid,date,date,text,text,text),public.copy_schedule_week(uuid,date,date,text,text,text) to authenticated;
commit;
