import { addDays, weekStart } from "../lib/scheduling/time";
import type { CopyPreview } from "../lib/scheduling/copy-types";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { migrationDatabase } from "./support/migration-database";

test("copy week: atomic preview, replacement, merge, conflict checks and tenant isolation", async () => {
  const db = await migrationDatabase();
  // Shift requests require future work; keep DST fixtures fixed and this workflow future-dated.
  const structureWeek = weekStart(
    addDays(new Date().toISOString().slice(0, 10), 370),
  );
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const f of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(await readFile(new URL(f, dir), "utf8"));
    async function row(sql: string, args: unknown[] = []): Promise<any> {
      return (await db.query(sql, args)).rows[0];
    }
    const user = "30000000-0000-0000-0000-000000000001";
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.test',now())",
      [user],
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      user,
    ]);
    await db.exec("set role authenticated");
    const org = (
      await row(
        "select public.create_workspace('Copy Test','America/Denver') id",
      )
    ).id;
    const cmd = async (
      command: string,
      payload: object,
      rev: number | null = null,
    ) =>
      (
        await row("select public.schedule_command($1,$2,$3,$4) r", [
          org,
          command,
          JSON.stringify(payload),
          rev,
        ])
      ).r;
    const rev = async (id: string) =>
      (await row("select revision from public.schedules where id=$1", [id]))
        .revision;
    const shifts = async (id: string) =>
      (
        await db.query<any>(
          "select * from public.shifts where schedule_id=$1 order by id",
          [id],
        )
      ).rows;
    const copy = async (
      source = "2026-10-25",
      dest = "2026-11-01",
      mode = "all",
      strategy = "merge",
      token: string | null = null,
    ): Promise<CopyPreview> =>
      (
        await row("select public.copy_schedule_week($1,$2,$3,$4,$5,$6) r", [
          org,
          source,
          dest,
          mode,
          strategy,
          token,
        ])
      ).r;
    const commit = async (
      source = "2026-10-25",
      dest = "2026-11-01",
      mode = "all",
      strategy = "merge",
    ) => {
      const p = await copy(source, dest, mode, strategy);
      return copy(source, dest, mode, strategy, p.token);
    };
    const src = await cmd("create", { week_start: "2026-10-25" });
    const employees = [];
    for (const name of ["Example One", "Example Two"])
      employees.push(
        (
          await row(
            "insert into public.employees(organization_id,display_name) values($1,$2) returning id",
            [org, name],
          )
        ).id,
      );
    const shared = await cmd(
      "group_save",
      {
        schedule_id: src.id,
        employee_id: employees[0],
        label: "Shared night",
        starts_at: "2026-10-25T06:00:00Z",
        ends_at: "2026-10-25T14:00:00Z",
        notes: "Front desk",
        required_count: 2,
        allow_overstaffing: false,
      },
      await rev(src.id),
    );
    await cmd(
      "group_assign",
      {
        schedule_id: src.id,
        shift_group_id: shared.id,
        employee_id: employees[1],
      },
      await rev(src.id),
    );
    const sourceBefore = await shifts(src.id);
    const p = await copy();
    assert.equal(p.added, 2);
    assert.equal(p.assigned, 2);
    assert.equal(
      (
        await row(
          "select count(*)::int n from public.schedules where organization_id=$1",
          [org],
        )
      ).n,
      1,
      "preview leaves no draft",
    );
    await copy("2026-10-25", "2026-11-01", "all", "merge", p.token);
    const dst = await row(
      "select * from public.schedules where organization_id=$1 and week_start=$2",
      [org, "2026-11-01"],
    );
    assert.equal((await shifts(dst.id)).length, 2);
    assert.equal(
      new Set((await shifts(dst.id)).map((s) => s.shift_group_id)).size,
      1,
    );
    assert.deepEqual(
      new Set((await shifts(dst.id)).map((s) => s.employee_id)),
      new Set(employees),
    );
    assert.ok(
      p.shifts.every(
        (s) => s.required_count === 2 && s.allow_overstaffing === false,
      ),
    );
    assert.equal(
      p.hours[0].hours,
      9,
      "DST fall-back preserves wall times, increasing elapsed hours",
    );
    assert.deepEqual(await shifts(src.id), sourceBefore, "source untouched");
    await commit();
    assert.equal(
      (await shifts(dst.id)).length,
      2,
      "repeated merge creates no duplicates",
    );
    await commit("2026-10-25", structureWeek, "structure");
    const structure = await row(
      "select * from public.schedules where organization_id=$1 and week_start=$2",
      [org, structureWeek],
    );
    assert.equal((await shifts(structure.id)).length, 2);
    assert.ok((await shifts(structure.id)).every((s) => !s.employee_id));
    await commit("2026-10-25", structureWeek, "assignments");
    assert.deepEqual(
      new Set((await shifts(structure.id)).map((s) => s.employee_id)),
      new Set(employees),
    );
    await commit("2026-10-25", structureWeek, "assignments");
    assert.equal((await shifts(structure.id)).length, 2);
    const stale = await copy();
    await cmd(
      "assign",
      {
        schedule_id: dst.id,
        id: (await shifts(dst.id))[0].id,
        employee_id: null,
      },
      await rev(dst.id),
    );
    await assert.rejects(
      copy("2026-10-25", "2026-11-01", "all", "merge", stale.token),
      /Stale revision/,
    );
    const replaced = await copy(
      "2026-10-25",
      "2026-11-01",
      "structure",
      "replace",
    );
    assert.equal(replaced.removed, 2);
    assert.ok(
      (await shifts(dst.id)).some((s) => s.employee_id),
      "replace preview does not clear assignments",
    );
    await copy(
      "2026-10-25",
      "2026-11-01",
      "structure",
      "replace",
      replaced.token,
    );
    assert.ok((await shifts(dst.id)).every((s) => !s.employee_id));
    assert.equal(
      (
        await row(
          "select count(*)::int n from public.schedule_copy_audits where schedule_id=$1",
          [dst.id],
        )
      ).n,
      3,
    );
    // Archived employees are skipped, never removed from source or historical snapshots.
    await db.exec("reset role");
    await db.query(
      "update public.employees set archived_at=now() where organization_id=$1 and id=$2",
      [org, employees[0]],
    );
    await db.exec("set role authenticated");
    const archived = await copy("2026-10-25", "2026-11-15");
    assert.equal(archived.skipped, 1);
    assert.equal(archived.assigned, 1);
    await commit("2026-10-25", "2026-11-15");
    await db.exec("reset role");
    await db.query(
      "update public.employees set archived_at=null where organization_id=$1",
      [org],
    );
    await db.exec("set role authenticated");
    // Hard time off fails before creating any destination rows.
    await db.exec("reset role");
    const constraint = await row(
      "insert into public.time_off_requests(organization_id,employee_id,start_date,end_date,full_day,timezone,starts_at,ends_at,status,created_by) values($1,$2,'2026-11-22','2026-11-22',true,'America/Denver','2026-11-22T07:00Z','2026-11-23T07:00Z','approved',$3) returning id",
      [org, employees[0], user],
    );
    await db.exec("set role authenticated");
    await assert.rejects(copy("2026-10-25", "2026-11-22"), /Approved time off/);
    assert.equal(
      (
        await row(
          "select count(*)::int n from public.schedules where week_start='2026-11-22'",
        )
      ).n,
      0,
    );
    await db.exec("reset role");
    await db.query(
      "update public.time_off_requests set status='cancelled' where id=$1",
      [constraint.id],
    );
    await db.query(
      "insert into public.employee_availability(organization_id,employee_id,weekday,unavailable) values($1,$2,0,true)",
      [org, employees[0]],
    );
    await db.exec("set role authenticated");
    const warning = await copy("2026-10-25", "2026-11-22");
    assert.equal(warning.availability.length, 1);
    await db.exec("reset role");
    await db.query(
      "update public.time_off_requests set status='approved' where id=$1",
      [constraint.id],
    );
    await db.exec("set role authenticated");
    await assert.rejects(
      copy("2026-10-25", "2026-11-22", "all", "merge", warning.token),
      /Stale revision/,
    );
    await db.exec("reset role");
    await db.query(
      "update public.time_off_requests set status='cancelled' where id=$1",
      [constraint.id],
    );
    await db.exec("set role authenticated");
    await cmd(
      "publish",
      { schedule_id: structure.id, allow_incomplete: true },
      await rev(structure.id),
    );
    const published = (
      await db.query(
        "select * from public.published_shifts where schedule_id=$1 order by id",
        [structure.id],
      )
    ).rows;
    // Pending shift requests and published audits stay byte-for-byte intact.
    await row("select public.shift_request_command($1,'open',$2) r", [
      org,
      JSON.stringify({ shift_id: (published[0] as any).id }),
    ]);
    const requests = (
      await db.query(
        "select * from public.shift_requests where organization_id=$1 order by id",
        [org],
      )
    ).rows;
    const publications = (
      await db.query(
        "select * from public.schedule_events where organization_id=$1 order by id",
        [org],
      )
    ).rows;
    const auditsBefore = (
      await row(
        "select count(*)::int n from public.assignment_events where organization_id=$1",
        [org],
      )
    ).n;
    await copy("2026-10-25", structureWeek, "structure", "replace");
    assert.equal(
      (
        await row(
          "select count(*)::int n from public.assignment_events where organization_id=$1",
          [org],
        )
      ).n,
      auditsBefore,
      "preview rolls back deferred assignment audits",
    );
    await commit("2026-10-25", structureWeek, "structure", "replace");
    assert.deepEqual(
      (
        await db.query(
          "select * from public.published_shifts where schedule_id=$1 order by id",
          [structure.id],
        )
      ).rows,
      published,
    );
    assert.deepEqual(
      (
        await db.query(
          "select * from public.shift_requests where organization_id=$1 order by id",
          [org],
        )
      ).rows,
      requests,
    );
    assert.deepEqual(
      (
        await db.query(
          "select * from public.schedule_events where organization_id=$1 order by id",
          [org],
        )
      ).rows,
      publications,
    );
    // Transaction rollback retains a nonempty draft if copied assignments conflict.
    const blocker = await cmd("create", { week_start: "2026-11-29" });
    await cmd(
      "slot_save",
      {
        schedule_id: blocker.id,
        employee_id: employees[0],
        label: "Existing work",
        starts_at: "2026-11-29T08:00Z",
        ends_at: "2026-11-29T12:00Z",
        notes: "",
      },
      await rev(blocker.id),
    );
    const blockerBefore = await shifts(blocker.id),
      blockerRev = await rev(blocker.id);
    await assert.rejects(copy("2026-10-25", "2026-11-29"), /overlapping/);
    assert.deepEqual(await shifts(blocker.id), blockerBefore);
    assert.equal(await rev(blocker.id), blockerRev);
    // Overnight and nonexistent/repeated DST hours.
    const night = await cmd("create", { week_start: "2026-02-22" });
    await cmd(
      "slot_save",
      {
        schedule_id: night.id,
        label: "Overnight",
        starts_at: "2026-02-23T06:00Z",
        ends_at: "2026-02-23T14:00Z",
        notes: "",
      },
      await rev(night.id),
    );
    const overnight = await copy("2026-02-22", "2026-03-08", "structure");
    assert.equal(overnight.shifts.length, 1);
    const dstGap = await cmd("create", { week_start: "2026-03-01" });
    await cmd(
      "slot_save",
      {
        schedule_id: dstGap.id,
        label: "DST gap",
        starts_at: "2026-03-01T09:30Z",
        ends_at: "2026-03-01T10:30Z",
        notes: "",
      },
      await rev(dstGap.id),
    );
    await assert.rejects(copy("2026-03-01", "2026-03-08"), /skipped daylight/);
    const repeat = await cmd("create", { week_start: "2026-10-18" });
    await cmd(
      "slot_save",
      {
        schedule_id: repeat.id,
        label: "Repeated hour",
        starts_at: "2026-10-18T07:30Z",
        ends_at: "2026-10-18T09:00Z",
        notes: "",
      },
      await rev(repeat.id),
    );
    await assert.rejects(copy("2026-10-18", "2026-11-01"), /repeated daylight/);
    await assert.rejects(copy("2026-10-25", "2026-10-25"), /different weeks/);
    await assert.rejects(copy("2026-10-25", "2026-11-02"), /whole calendar/);
    await assert.rejects(
      copy("2026-10-25", "2026-12-06", "assignments"),
      /create destination shifts/,
    );
    // Recurring staffing slots keep their requirement identity, counts, notes and settings.
    const templates = (
      await db.query<any>(
        "select id from public.shift_templates where organization_id=$1 order by start_time",
        [org],
      )
    ).rows;
    await row("select public.save_weekly_setup($1,$2,$3,null) r", [
      org,
      JSON.stringify([
        { template_id: templates[0].id, days: [0], required_count: 2 },
      ]),
      0,
    ]);
    const recurring = await cmd("create", { week_start: "2026-12-13" });
    const recurringBefore = await shifts(recurring.id);
    assert.equal(recurringBefore.length, 2);
    await db.exec("reset role");
    await db.query(
      "update public.shift_groups set allow_overstaffing=false where schedule_id=$1",
      [recurring.id],
    );
    await db.exec("set role authenticated");
    const required = await copy("2026-12-13", "2026-12-20", "structure");
    assert.equal(required.shifts.length, 2);
    for (const slot of required.shifts) {
      assert.ok(slot.is_required);
      assert.equal(slot.requirement_id, recurringBefore[0].requirement_id);
    }
    const concurrent = await Promise.allSettled([
      copy("2026-12-13", "2026-12-20", "structure", "merge", required.token),
      copy("2026-12-13", "2026-12-20", "structure", "merge", required.token),
    ]);
    assert.equal(
      concurrent.filter((r) => r.status === "fulfilled").length,
      1,
      "one confirmation wins its revision check",
    );
    const requiredDst = await row(
      "select * from public.schedules where organization_id=$1 and week_start='2026-12-20'",
      [org],
    );
    assert.ok(
      (
        await db.query<any>(
          "select allow_overstaffing from public.shift_groups where schedule_id=$1",
          [requiredDst.id],
        )
      ).rows.every((g) => g.allow_overstaffing === false),
    );
    await commit("2026-12-13", "2026-12-20", "structure");
    assert.equal((await shifts(requiredDst.id)).length, 2);
    assert.deepEqual(await shifts(recurring.id), recurringBefore);
    const rules = (
      await db.query(
        "select * from public.coverage_requirements where organization_id=$1 order by id",
        [org],
      )
    ).rows;
    await commit("2026-12-13", "2026-12-27", "structure");
    assert.deepEqual(
      (
        await db.query(
          "select * from public.coverage_requirements where organization_id=$1 order by id",
          [org],
        )
      ).rows,
      rules,
      "copy never modifies recurring setup",
    );
    // Independent organization owners and employees cannot copy this organization's data.
    await db.exec("reset role");
    const outsider = "30000000-0000-0000-0000-000000000002";
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'outsider@example.test',now())",
      [outsider],
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      outsider,
    ]);
    await db.exec("set role authenticated");
    await row("select public.create_workspace('Other','America/Denver')");
    await assert.rejects(copy(), /permission denied/);
    assert.equal(
      (
        await row(
          "select count(*)::int n from public.schedule_copy_audits where organization_id=$1",
          [org],
        )
      ).n,
      0,
    );
    await db.exec("reset role");
    await db.query(
      "insert into public.memberships(organization_id,user_id,role) values($1,$2,'employee')",
      [org, outsider],
    );
    await db.exec("set role authenticated");
    await assert.rejects(copy(), /permission denied/);
    await db.exec("reset role;set role anon");
    await assert.rejects(copy(), /permission denied/);
  } finally {
    await db.close();
  }
});
