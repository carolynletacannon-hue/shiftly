begin;

-- Employee identity already uses (organization_id, id). A color is therefore
-- workplace-specific, including when one account belongs to several workplaces.
-- A constant default supplies sage to existing rows without an UPDATE/backfill
-- and never overwrites an employee's manually saved color on later edits.
alter table public.employees
  add column color_key text not null default 'sage'
  constraint employees_color_key_check
  check (color_key in ('sage','blue','purple','coral','amber','teal','pink','slate'));

-- Keep the existing roster_read / roster_add / roster_edit RLS policies.
-- The UPDATE policy checks owner/manager membership in both USING and WITH CHECK.
-- Grant only this column; do not grant table-wide writes or contact reads.
grant select (color_key), insert (color_key), update (color_key)
  on public.employees to authenticated;

comment on column public.employees.color_key is
  'Current workplace employee palette key. Presentation only; published shift snapshots remain unchanged.';

commit;
