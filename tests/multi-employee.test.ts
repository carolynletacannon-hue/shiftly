import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { groupShifts, staffing } from "../lib/scheduling/groups";
import type { Shift } from "../lib/scheduling/types";

test("calendar groups by persisted shift identity and counts people independently of capacity", () => {
  const base = {
    schedule_id: "week",
    starts_at: "2026-11-02T14:00Z",
    ends_at: "2026-11-02T22:00Z",
    notes: "",
  };
  const rows: Shift[] = [
    {
      ...base,
      id: "a",
      employee_id: "one",
      shift_group_id: "shared",
      required_count: 3,
    },
    {
      ...base,
      id: "b",
      employee_id: "two",
      shift_group_id: "shared",
      required_count: 3,
    },
    {
      ...base,
      id: "c",
      employee_id: "three",
      shift_group_id: "unrelated",
      required_count: 1,
    },
  ];
  assert.equal(groupShifts(rows).length, 2);
  assert.deepEqual(
    groupShifts(rows)[0].assignments.map((a) => a.id),
    ["a", "b"],
  );
  assert.deepEqual(staffing(rows), { required: 4, covered: 3, unfilled: 1 });
  assert.equal(
    groupShifts(rows.filter((s) => s.employee_id === "one"))[0].assignments
      .length,
    1,
  );
});

test("live-schema upgrade preserves assignment ids and frozen publications; shared shifts mutate atomically", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const latest = files.find((f) => f.endsWith("_multi_employee_shifts.sql"))!;
    for (const file of files.filter((f) => f < latest))
      await db.exec(await readFile(new URL(file, dir), "utf8"));
    const users = [
      "30000000-0000-0000-0000-000000000001",
      "30000000-0000-0000-0000-000000000002",
    ];
    for (const [i, id] of users.entries())
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [id, `test${i}@example.test`],
      );
    async function as(id: string) {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        id,
      ]);
      await db.exec("set role authenticated");
    }
    async function row(sql: string, args: unknown[] = []): Promise<any> {
      return (await db.query(sql, args)).rows[0];
    }
    await as(users[0]);
    const org = (
      await row(
        "select public.create_workspace('Fictional Hotel','America/Denver') id",
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
    const employees = [];
    for (let i = 0; i < 4; i++)
      employees.push(
        (
          await row(
            "insert into public.employees(organization_id,display_name) values($1,$2) returning id",
            [org, `Placeholder ${i + 1}`],
          )
        ).id,
      );
    const draft = await cmd("create", { week_start: "2026-11-01" });
    const revision = async () =>
      (
        await row("select revision from public.schedules where id=$1", [
          draft.id,
        ])
      ).revision;
    const template = (
      await row(
        "select id from public.shift_templates where organization_id=$1 order by start_time limit 1",
        [org],
      )
    ).id;
    const requirement = (
      await cmd("requirement_save", {
        template_id: template,
        weekday: 1,
        required_count: 3,
      })
    ).id;
    // Seed genuine old-style recurring siblings and independent custom rows.
    await db.exec("reset role");
    for (let i = 0; i < 3; i++)
      await db.query(
        `insert into public.shifts(organization_id,schedule_id,employee_id,starts_at,ends_at,label,requirement_id,template_id,slot_ordinal,is_required,slot_kind)
 values($1,$2,$3,'2026-11-02T14:00Z','2026-11-02T22:00Z','Morning',$4,$5,$6,true,'requirement')`,
        [org, draft.id, employees[i], requirement, template, i + 1],
      );
    await db.query(
      `insert into public.shifts(organization_id,schedule_id,starts_at,ends_at,label,notes,slot_kind) values
 ($1,$2,'2026-11-03T14:00Z','2026-11-03T22:00Z','Independent','Private note','one_off'),
 ($1,$2,'2026-11-03T14:00Z','2026-11-03T22:00Z','Independent','Private note','one_off'),
 ($1,$2,'2026-11-02T14:00Z','2026-11-02T22:00Z','Morning','Different notes','requirement')`,
      [org, draft.id],
    );
    await db.query(
      `insert into public.shifts(organization_id,schedule_id,starts_at,ends_at,label,notes,requirement_id,template_id,slot_ordinal,is_required,slot_kind)
 values($1,$2,'2026-11-02T14:00Z','2026-11-02T22:00Z','Morning','Different recurring note',$3,$4,4,true,'requirement'),
 ($1,$2,'2026-11-02T14:00Z','2026-11-02T22:00Z','Different label','',$3,$4,5,true,'requirement')`,
      [org, draft.id, requirement, template],
    );
    await as(users[0]);
    await cmd(
      "publish",
      { schedule_id: draft.id, allow_incomplete: true },
      await revision(),
    );
    const oldDraft = (
      await db.query<any>("select * from public.shifts order by id")
    ).rows;
    const oldPublished = (
      await db.query<any>("select * from public.published_shifts order by id")
    ).rows;
    const oldPublication = (
      await db.query("select * from public.published_schedules")
    ).rows;
    await db.exec("reset role");
    // A real upgrade, after data and a publication already exist.
    await db.exec(await readFile(new URL(latest, dir), "utf8"));
    await as(users[0]);
    for (const old of oldDraft) {
      const now = await row("select * from public.shifts where id=$1", [
        (old as any).id,
      ]);
      for (const key of Object.keys(old))
        assert.deepEqual(now[key], (old as any)[key]);
    }
    for (const old of oldPublished) {
      const now = await row(
        "select * from public.published_shifts where id=$1",
        [(old as any).id],
      );
      for (const key of Object.keys(old))
        assert.deepEqual(now[key], (old as any)[key]);
    }
    assert.deepEqual(
      (await db.query("select * from public.published_schedules")).rows,
      oldPublication,
    );
    const shared = await row(
      "select shift_group_id from public.shifts where employee_id=$1",
      [employees[0]],
    );
    assert.equal(
      (await row("select count(*)::int n from public.shift_groups")).n,
      6,
    );
    assert.equal(
      (
        await row(
          "select count(*)::int n from public.shift_assignments where shift_group_id=$1",
          [shared.shift_group_id],
        )
      ).n,
      3,
    );
    const groupPayload = {
      schedule_id: draft.id,
      shift_group_id: shared.shift_group_id,
    };
    // Lower capacity preserves all employees and all assignment identities.
    await cmd(
      "group_staffing",
      { ...groupPayload, required_count: 2, allow_overstaffing: true },
      await revision(),
    );
    await assert.rejects(
      cmd(
        "group_staffing",
        { ...groupPayload, required_count: 2, allow_overstaffing: false },
        await revision(),
      ),
      /overstaffing/,
    );
    assert.equal(
      (
        await row(
          "select required_count from public.shift_groups where id=$1",
          [shared.shift_group_id],
        )
      ).required_count,
      2,
    );
    const assignments = async () =>
      (
        await db.query<any>(
          "select * from public.shifts where shift_group_id=$1 order by id",
          [shared.shift_group_id],
        )
      ).rows;
    const before = await assignments();
    await cmd(
      "group_assign",
      { ...groupPayload, assignment_id: before[0].id, employee_id: "" },
      await revision(),
    );
    assert.deepEqual(
      (await assignments()).filter((a) => a.id !== before[0].id),
      before.filter((a) => a.id !== before[0].id),
    );
    await cmd(
      "group_assign",
      { ...groupPayload, employee_id: employees[3] },
      await revision(),
    );
    assert.deepEqual(
      (await assignments()).map((a) => a.id),
      before.map((a) => a.id),
    );
    // Duplicate assignment and foreign assignment ids fail with complete rollback.
    const current = await assignments();
    await assert.rejects(
      cmd(
        "group_assign",
        { ...groupPayload, employee_id: current[1].employee_id },
        await revision(),
      ),
      /overlapping/,
    );
    await assert.rejects(
      cmd(
        "group_assign",
        {
          ...groupPayload,
          assignment_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
          employee_id: "",
        },
        await revision(),
      ),
      /Assignment unavailable/,
    );
    assert.deepEqual(await assignments(), current);
    const pubBefore = (
      await db.query<any>("select * from public.published_shifts order by id")
    ).rows;
    await cmd(
      "group_save",
      {
        ...groupPayload,
        label: "Shared overnight",
        start_local: "",
        starts_at: "2026-11-02T06:00Z",
        ends_at: "2026-11-02T14:00Z",
        notes: "Shared note",
        required_count: 4,
      },
      await revision(),
    );
    assert.equal(
      (await assignments()).every(
        (a) => a.label === "Shared overnight" && a.notes === "Shared note",
      ),
      true,
    );
    assert.deepEqual(
      (await db.query<any>("select * from public.published_shifts order by id"))
        .rows,
      pubBefore,
    );
    // Two callers using the same observed revision cannot both commit.
    const rev = await revision();
    const outcomes = await Promise.allSettled([
      cmd("group_staffing", { ...groupPayload, required_count: 4 }, rev),
      cmd("group_staffing", { ...groupPayload, required_count: 5 }, rev),
    ]);
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    await assert.rejects(
      cmd("publish", { schedule_id: draft.id }, rev),
      /Stale revision/,
    );
    await assert.rejects(
      cmd("publish", { schedule_id: draft.id }, await revision()),
      /Unfilled required/,
    );
    await cmd(
      "publish",
      { schedule_id: draft.id, allow_incomplete: true },
      await revision(),
    );
    const published = (
      await db.query<any>(
        "select * from public.published_shifts where shift_group_id=$1",
        [shared.shift_group_id],
      )
    ).rows;
    assert.equal(published.filter((a) => a.employee_id).length, 3);
    assert.equal(
      published.every((a) => a.label === "Shared overnight"),
      true,
    );
    assert.deepEqual(
      published
        .filter((a) => a.employee_id)
        .map((a) => a.id)
        .sort(),
      current.map((a) => a.id).sort(),
    );
    // Single-assignment transfer leaves every coworker and the published version alone.
    await cmd(
      "group_assign",
      {
        ...groupPayload,
        assignment_id: current[0].id,
        employee_id: before[0].employee_id,
      },
      await revision(),
    );
    assert.deepEqual(
      (
        await db.query(
          "select * from public.published_shifts where shift_group_id=$1",
          [shared.shift_group_id],
        )
      ).rows,
      published,
    );
    assert.ok(
      (await row("select count(*)::int n from public.assignment_events")).n >=
        5,
    );
    assert.equal((await row("select count(*)::int n from public.assignment_events e join public.schedules s on s.id=e.schedule_id where e.revision>s.revision")).n,0);
    const finalRevision = await revision();
    await as(users[1]);
    const foreign = (
      await row("select public.create_workspace('Other Hotel','UTC') id")
    ).id;
    assert.notEqual(foreign, org);
    assert.equal(
      (
        await db.query(
          "select * from public.shift_groups where organization_id=$1",
          [org],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query(
          "select * from public.shift_assignments where organization_id=$1",
          [org],
        )
      ).rows.length,
      0,
    );
    await assert.rejects(
      cmd(
        "group_staffing",
        { ...groupPayload, required_count: 1 },
        finalRevision,
      ),
      /permission denied|Schedule permission denied/i,
    );
    await db.exec("reset role;set role anon");
    await assert.rejects(db.query("select * from public.shift_assignments"));
  } finally {
    await db.close();
  }
});
