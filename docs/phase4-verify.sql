-- Read-only release checks. Run after applying the complete Phase 4 migration.
select tablename,rowsecurity from pg_tables where schemaname='public' and tablename in
 ('shift_coverage_policies','shift_requests','shift_request_responses','employee_time_off','employee_weekly_availability','shift_notifications','shift_email_deliveries') order by tablename;
select n.nspname,p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where p.proname in ('shift_request_command','transfer_preview','claim_shift_emails','queue_shift_email');
select has_table_privilege('authenticated','public.shift_requests','INSERT') as must_be_false,
 has_table_privilege('authenticated','public.shift_email_deliveries','SELECT') as must_be_false,
 has_function_privilege('anon','public.shift_request_command(uuid,text,jsonb)','EXECUTE') as must_be_false;
select organization_id,require_manager,revision from public.shift_coverage_policies;
select count(*) as queued_email, count(*) filter(where sent_at is null and attempts>=10) as exhausted_email from public.shift_email_deliveries;
