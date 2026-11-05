begin;
create or replace function shiftly_private.save_weekly_setup(org uuid,items jsonb,expected_revision integer) returns void
language plpgsql security definer set search_path='' as $$
declare item jsonb; day jsonb; template uuid; current_version integer; total integer:=0; requirement uuid;
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
     if coalesce(length(trim(item->>'name')),0) not between 1 and 60 then raise exception 'Enter a shift name (1–60 characters)'; end if;
     if item->>'start_time' is null or item->>'end_time' is null then raise exception 'Choose a start and end time'; end if;
     if not coalesce((item->>'end_next_day')::boolean,false) and (item->>'end_time')::time<=(item->>'start_time')::time then
       raise exception 'End time must be after start time, or select ends next day';
     end if;
     if coalesce((item->>'end_next_day')::boolean,false) and (item->>'end_time')::time>(item->>'start_time')::time then
       raise exception 'An overnight shift must end within 24 local hours';
     end if;
     select id into template from public.shift_templates where organization_id=org and name=trim(item->>'name')
       and start_time=(item->>'start_time')::time and end_time=(item->>'end_time')::time
       and end_next_day=coalesce((item->>'end_next_day')::boolean,false);
     if template is null and exists(select 1 from public.shift_templates where organization_id=org and name=trim(item->>'name')) then
       raise exception 'A shift named % already exists. Select its template or choose another name',trim(item->>'name');
     end if;
     if template is null then
     insert into public.shift_templates(organization_id,name,start_time,end_time,end_next_day)
     values(org,trim(item->>'name'),(item->>'start_time')::time,(item->>'end_time')::time,coalesce((item->>'end_next_day')::boolean,false)) returning id into template;
     end if;
   elsif not exists(select 1 from public.shift_templates where organization_id=org and id=template) then raise exception 'Template unavailable'; end if;
   if coalesce((item->>'required_count')::integer,0) not between 1 and 50 then raise exception 'Choose a staffing count between 1 and 50'; end if;
   if jsonb_typeof(item->'days')<>'array' or coalesce(jsonb_array_length(item->'days'),0)=0 or jsonb_array_length(item->'days')>7 then raise exception 'Choose weekdays'; end if;
   for day in select distinct value from jsonb_array_elements(item->'days') loop
     if (day#>>'{}')::integer not between 0 and 6 then raise exception 'Choose weekdays from Sunday through Saturday'; end if;
     total:=total+(item->>'required_count')::integer;
     if total>300 then raise exception 'Weekly shift limit reached'; end if;
     select id into requirement from public.coverage_requirements
       where organization_id=org and template_id=template and weekday=(day#>>'{}')::smallint
       and position_id is not distinct from nullif(item->>'position_id','')::uuid and not is_active
       order by created_at desc,id limit 1;
     if requirement is null then
       insert into public.coverage_requirements(organization_id,template_id,weekday,position_id,required_count)
       values(org,template,(day#>>'{}')::smallint,nullif(item->>'position_id','')::uuid,(item->>'required_count')::smallint);
     else
       update public.coverage_requirements set is_active=true,required_count=(item->>'required_count')::smallint,revision=revision+1 where id=requirement;
     end if;
   end loop;
 end loop;
 update public.weekly_setup_versions set revision=revision+1 where organization_id=org;
end $$;
-- The organization lock matches every schedule/configuration command. Reconcile
-- the latest draft under that lock; stale calendar edits fail their revision check.
create function shiftly_private.save_weekly_setup_and_apply(
 org uuid,items jsonb,expected_revision integer,apply_week date
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 s public.schedules; req record; day_date date; local_start timestamp; local_end timestamp;
 slot_start timestamptz; slot_end timestamptz; ordinal integer; matched uuid;
 used uuid[]:='{}'; added integer:=0; removed integer:=0; changed integer:=0;
 tz text; week_day integer;
begin
 -- Reuses manager authorization, organization lock, validation and revision CAS.
 perform shiftly_private.save_weekly_setup(org,items,expected_revision);
 if apply_week is null then return jsonb_build_object('applied',false); end if;
 select timezone,coalesce((settings->>'week_starts_on')::integer,0) into tz,week_day
 from public.organizations where id=org;
 if extract(dow from apply_week)::integer<>week_day then raise exception 'Choose the workspace week start'; end if;
 select * into s from public.schedules where organization_id=org and week_start=apply_week for update;
 if s.id is null then
   return shiftly_private.schedule_command(org,'create',jsonb_build_object('week_start',apply_week),null)
     ||jsonb_build_object('applied',true);
 end if;
 -- Saving setup never edits a previously published week, even its working copy.
 if s.published_revision is not null then
   raise exception 'This week has been published. Choose future weeks only; use the calendar to explicitly revise and publish this week';
 end if;
 -- Detach recurring keys before matching so count reductions can retain assigned
 -- slots without transient unique-key collisions. All changes roll back together.
 update public.shifts set requirement_id=null where schedule_id=s.id and slot_kind='requirement';
 for req in select r.*,t.name,t.start_time,t.end_time,t.end_next_day,
   coalesce(r.position_id,t.position_id) resolved_position
   from public.coverage_requirements r join public.shift_templates t
   on t.organization_id=r.organization_id and t.id=r.template_id
   where r.organization_id=org and r.is_active order by r.weekday,t.start_time,r.id
 loop
   day_date:=apply_week+((req.weekday-extract(dow from apply_week)::integer+7)%7);
   local_start:=day_date+req.start_time;
   local_end:=(day_date+case when req.end_next_day then 1 else 0 end)+req.end_time;
   slot_start:=local_start at time zone s.timezone;
   slot_end:=local_end at time zone s.timezone;
   if slot_start at time zone s.timezone<>local_start or slot_end at time zone s.timezone<>local_end then
     raise exception 'A required slot falls in a skipped daylight-saving hour';
   end if;
   for ordinal in 1..req.required_count loop
     matched:=null;
     -- Prefer assigned shifts. Preserve their id, employee, times and notes.
     select id into matched from public.shifts where schedule_id=s.id
       and not(id=any(used)) and starts_at=slot_start and ends_at=slot_end
       and position_id is not distinct from req.resolved_position
       order by (employee_id is not null) desc,id limit 1;
     if matched is null then
       insert into public.shifts(organization_id,schedule_id,starts_at,ends_at,label,
         requirement_id,template_id,position_id,slot_ordinal,is_required,slot_kind)
       values(org,s.id,slot_start,slot_end,req.name,req.id,req.template_id,
         req.resolved_position,ordinal,true,'requirement') returning id into matched;
       added:=added+1;
     else
       update public.shifts set requirement_id=req.id,slot_ordinal=ordinal,is_required=true,slot_kind='requirement'
       where id=matched;
     end if;
     used:=array_append(used,matched);
   end loop;
 end loop;
 -- Obsolete empty generated slots can be removed. Assigned/custom slots survive.
 delete from public.shifts where schedule_id=s.id and slot_kind='requirement'
   and employee_id is null and not(id=any(used));
 get diagnostics removed=row_count;
 update public.shifts set requirement_id=null,is_required=false,slot_kind='one_off'
   where schedule_id=s.id and slot_kind='requirement' and not(id=any(used));
 get diagnostics changed=row_count;
 if (select count(*) from public.shifts where schedule_id=s.id)>300 then raise exception 'Weekly shift limit reached'; end if;
 perform shiftly_private.validate_schedule(s.id);
 update public.schedules set revision=revision+1,updated_at=now() where id=s.id;
 return jsonb_build_object('applied',true,'added',added,'removed',removed,'preserved',changed);
end $$;
create function public.save_weekly_setup(org uuid,items jsonb,expected_revision integer,apply_week date)
returns jsonb language sql security invoker set search_path='' as $$
 select shiftly_private.save_weekly_setup_and_apply(org,items,expected_revision,apply_week)
$$;
revoke all on function shiftly_private.save_weekly_setup_and_apply(uuid,jsonb,integer,date),
 public.save_weekly_setup(uuid,jsonb,integer,date) from public,anon;
grant execute on function shiftly_private.save_weekly_setup_and_apply(uuid,jsonb,integer,date),
 public.save_weekly_setup(uuid,jsonb,integer,date) to authenticated;

commit;
