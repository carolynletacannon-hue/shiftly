import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { copyTimes } from "../lib/scheduling/time";
import { groupShifts } from "../lib/scheduling/groups";
import { migrationDatabase } from "./support/migration-database";

test("pending live-schema consents survive upgrade; coverage, swaps, time off and automatic transfers affect individual assignments", async () => {
  const db = await migrationDatabase();
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const upgrade = files.find((f) =>
      f.endsWith("_multi_employee_shifts.sql"),
    )!;
    for (const f of files.filter((f) => f < upgrade))
      await db.exec(await readFile(new URL(f, dir), "utf8"));
    const users = Array.from(
      { length: 4 },
      (_, i) => `90000000-0000-0000-0000-00000000000${i + 1}`,
    );
    for (const [i, u] of users.entries())
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())",
        [u, `synthetic${i}@example.test`],
      );
    const row = async (sql: string, args: unknown[] = []): Promise<any> =>
      (await db.query(sql, args)).rows[0];
    async function as(i: number) {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        users[i],
      ]);
      await db.exec("set role authenticated");
    }
    await as(0);
    const org = (
      await row(
        "select public.create_workspace('Synthetic Shared Team','America/Denver') id",
      )
    ).id;
    await db.exec("reset role");
    for (const u of users.slice(1))
      await db.query(
        "insert into public.memberships values($1,$2,'employee')",
        [org, u],
      );
    await as(0);
    const schedule = async (
      cmd: string,
      payload: object,
      rev: number | null = null,
    ) =>
      (
        await row("select public.schedule_command($1,$2,$3,$4) r", [
          org,
          cmd,
          JSON.stringify(payload),
          rev,
        ])
      ).r;
    const request = async (cmd: string, payload: object) =>
      (
        await row("select public.shift_request_command($1,$2,$3) r", [
          org,
          cmd,
          JSON.stringify(payload),
        ])
      ).r;
    const off = async (cmd: string, payload: object) =>
      (
        await row("select public.time_off_command($1,$2,$3) r", [
          org,
          cmd,
          JSON.stringify(payload),
        ])
      ).r;
    const first = await schedule("create", { week_start: "2030-01-06" });
    const template = (
      await row(
        "select id from public.shift_templates where organization_id=$1 and name='Morning'",
        [org],
      )
    ).id;
    for (const weekday of [1, 2])
      await schedule("requirement_save", {
        template_id: template,
        weekday,
        required_count: 2,
      });
    const second = await schedule("create", { week_start: "2030-01-13" });
    // The first week's pre-existing slots use the same recurring identities.
    await db.exec("reset role");
    for (const r of (
      await db.query<any>(
        "select * from public.coverage_requirements where organization_id=$1",
        [org],
      )
    ).rows) {
      for (let i = 0; i < 2; i++)
        await db.query(
          `insert into public.shifts(organization_id,schedule_id,starts_at,ends_at,label,requirement_id,template_id,slot_ordinal,is_required,slot_kind)
  values($1,$2,($3::date+time '07:00') at time zone 'America/Denver',($3::date+time '15:00') at time zone 'America/Denver','Morning',$4,$5,$6,true,'requirement')`,
          [
            org,
            first.id,
            r.weekday === 1 ? "2030-01-07" : "2030-01-08",
            r.id,
            template,
            i + 1,
          ],
        );
    }
    await as(0);
    const revision = async (id: string) =>
      (await row("select revision from public.schedules where id=$1", [id]))
        .revision;
    const slots = async (id: string) =>
      (
        await db.query<any>(
          "select * from public.shifts where schedule_id=$1 order by starts_at,slot_ordinal",
          [id],
        )
      ).rows;
    let a = await slots(first.id),
      b = await slots(second.id);
    for (const [slot, user] of [
      [a[0], users[1]],
      [a[1], users[2]],
      [b[0], users[1]],
      [b[1], users[3]],
      [b[2], users[2]],
      [b[3], users[0]],
    ] as const)
      await schedule(
        "assign",
        { schedule_id: slot.schedule_id, id: slot.id, employee_id: user },
        await revision(slot.schedule_id),
      );
    for (const id of [first.id, second.id])
      await schedule(
        "publish",
        { schedule_id: id, allow_incomplete: true },
        await revision(id),
      );
    await as(1);
    let coverage = await request("coverage", { shift_id: a[0].id });
    await as(3);
    coverage = await request("accept", { request_id: coverage.id });
    assert.equal(coverage.status, "pending");
    await as(1);
    let swap = await request("swap", {
      shift_id: b[0].id,
      other_shift_id: b[2].id,
    });
    await as(2);
    swap = await request("accept", { request_id: swap.id });
    assert.equal(swap.status, "pending");
    await as(0);
    const before = (
      await db.query<any>("select * from public.shift_requests order by id")
    ).rows;
    const responses = (
      await db.query(
        "select * from public.shift_request_responses order by request_id",
      )
    ).rows;
    const notifications = (
      await db.query("select * from public.shift_notifications order by id")
    ).rows;
    const pubs = (
      await db.query("select * from public.published_schedules order by id")
    ).rows;
    await db.exec("reset role");
    await db.exec(await readFile(new URL(upgrade, dir), "utf8"));
    await as(0);
    const strip = (snapshot: any) => {
      const { shift_group_id, required_count, allow_overstaffing, ...old } =
        snapshot;
      return old;
    };
    const after = (
      await db.query<any>("select * from public.shift_requests order by id")
    ).rows;
    for (let i = 0; i < before.length; i++) {
      const { source_snapshot, other_snapshot, ...rest } = after[i];
      assert.deepEqual(
        rest,
        (({ source_snapshot, other_snapshot, ...r }) => r)(before[i]),
      );
      assert.deepEqual(strip(source_snapshot), before[i].source_snapshot);
      if (other_snapshot)
        assert.deepEqual(strip(other_snapshot), before[i].other_snapshot);
    }
    assert.deepEqual(
      (
        await db.query(
          "select * from public.shift_request_responses order by request_id",
        )
      ).rows,
      responses,
    );
    assert.deepEqual(
      (await db.query("select * from public.shift_notifications order by id"))
        .rows,
      notifications,
    );
    assert.deepEqual(
      (await db.query("select * from public.published_schedules order by id"))
        .rows,
      pubs,
    );
    a = await slots(first.id);
    b = await slots(second.id);
    assert.equal(a[0].shift_group_id, a[1].shift_group_id);
    assert.equal(b[0].shift_group_id, b[1].shift_group_id);
    const coworkerA = await row(
      "select * from public.published_shifts where id=$1",
      [a[1].id],
    );
    const coworkersB = (
      await db.query(
        "select * from public.published_shifts where id in ($1,$2) order by id",
        [b[1].id, b[3].id],
      )
    ).rows;
    assert.equal(
      (await request("approve", { request_id: coverage.id })).status,
      "completed",
    );
    assert.equal(
      (
        await row(
          "select employee_id from public.published_shifts where id=$1",
          [a[0].id],
        )
      ).employee_id,
      users[3],
    );
    assert.deepEqual(
      await row("select * from public.published_shifts where id=$1", [a[1].id]),
      coworkerA,
    );
    assert.equal(
      (await request("approve", { request_id: swap.id })).status,
      "completed",
    );
    assert.equal(
      (
        await row(
          "select employee_id from public.published_shifts where id=$1",
          [b[0].id],
        )
      ).employee_id,
      users[2],
    );
    assert.equal(
      (
        await row(
          "select employee_id from public.published_shifts where id=$1",
          [b[2].id],
        )
      ).employee_id,
      users[1],
    );
    assert.deepEqual(
      (
        await db.query(
          "select * from public.published_shifts where id in ($1,$2) order by id",
          [b[1].id, b[3].id],
        )
      ).rows,
      coworkersB,
    );
    // Time off can be repaired one assignment at a time within the shared shift.
    await as(2);
    const timeOff = await off("submit", {
      employee_id: users[2],
      start_date: "2030-01-07",
      end_date: "2030-01-07",
      full_day: true,
    });
    await as(0);
    await off("approve", { id: timeOff.id });
    await schedule(
      "group_assign",
      {
        schedule_id: first.id,
        shift_group_id: a[0].shift_group_id,
        assignment_id: a[1].id,
        employee_id: "",
      },
      await revision(first.id),
    );
    await assert.rejects(
      schedule(
        "group_assign",
        {
          schedule_id: first.id,
          shift_group_id: a[0].shift_group_id,
          employee_id: users[2],
        },
        await revision(first.id),
      ),
      /Approved time off/,
    );
    assert.equal(
      (
        await row("select employee_id from public.shifts where id=$1", [
          a[0].id,
        ])
      ).employee_id,
      users[3],
    );
    // Policy-permitted automatic transfers still update just one assignment.
    let policy = await row(
      "select * from public.shift_coverage_policies where organization_id=$1",
      [org],
    );
    await request("policy", {
      revision: policy.revision,
      require_manager: false,
    });
    await as(3);
    let automatic = await request("coverage", { shift_id: b[1].id });
    await as(0);
    automatic = await request("accept", { request_id: automatic.id });
    assert.equal(automatic.status, "completed");
    assert.equal(
      (
        await row(
          "select employee_id from public.published_shifts where id=$1",
          [b[0].id],
        )
      ).employee_id,
      users[2],
    );
    assert.equal(
      (
        await row(
          "select employee_id from public.published_shifts where id=$1",
          [b[1].id],
        )
      ).employee_id,
      users[0],
    );
    await assert.rejects(
      request("approve", { request_id: automatic.id }),
      /no longer pending/,
    );
    // Recurring overstaffing and custom shared groups keep all people when copied.
    const extra = await row(
      "insert into public.employees(organization_id,display_name) values($1,'Synthetic placeholder') returning id",
      [org],
    );
    await schedule(
      "group_assign",
      {
        schedule_id: second.id,
        shift_group_id: b[0].shift_group_id,
        employee_id: extra.id,
      },
      await revision(second.id),
    );
    await schedule(
      "group_save",
      {
        schedule_id: second.id,
        label: "Special event",
        starts_at: "2030-01-16T14:00Z",
        ends_at: "2030-01-16T18:00Z",
        required_count: 2,
        employee_id: users[1],
      },
      await revision(second.id),
    );
    const custom = await row(
      "select id from public.shift_groups where schedule_id=$1 and label='Special event'",
      [second.id],
    );
    await schedule(
      "group_assign",
      {
        schedule_id: second.id,
        shift_group_id: custom.id,
        employee_id: users[2],
      },
      await revision(second.id),
    );
    const source = (
      await db.query<any>(
        "select a.*,g.required_count,g.allow_overstaffing from public.shifts a join public.shift_groups g on g.id=a.shift_group_id where a.schedule_id=$1",
        [second.id],
      )
    ).rows;
    const copied = await schedule("create", {
      week_start: "2030-01-20",
      slots: source.map((a) => ({
        ...a,
        ...copyTimes(
          {
            ...a,
            starts_at: new Date(a.starts_at).toISOString(),
            ends_at: new Date(a.ends_at).toISOString(),
          },
          "2030-01-13",
          "2030-01-20",
          "America/Denver",
          "America/Denver",
        ),
        copy_group_key: a.shift_group_id,
      })),
    });
    const copiedRows = await slots(copied.id);
    const copiedGroups = groupShifts(copiedRows);
    assert.equal(copiedGroups.length, 3);
    assert.equal(
      copiedGroups.find((g) => g.label === "Special event")?.assignments.length,
      2,
    );
    assert.equal(
      copiedGroups
        .filter((g) => g.is_required)
        .reduce((n, g) => n + g.assignments.length, 0),
      5,
    );
    // An old published vacancy must not bypass a newly reduced draft limit.
    const volunteerGroup = await schedule(
      "group_save",
      {
        schedule_id: second.id,
        label: "Volunteer",
        starts_at: "2030-01-17T14:00Z",
        ends_at: "2030-01-17T18:00Z",
        required_count: 2,
        employee_id: users[1],
      },
      await revision(second.id),
    );
    await schedule(
      "publish",
      { schedule_id: second.id, allow_incomplete: true },
      await revision(second.id),
    );
    const vacancy = await row(
      "select * from public.published_shifts where shift_group_id=$1 and employee_id is null",
      [volunteerGroup.id],
    );
    await schedule(
      "group_staffing",
      {
        schedule_id: second.id,
        shift_group_id: volunteerGroup.id,
        required_count: 1,
        allow_overstaffing: false,
      },
      await revision(second.id),
    );
    await as(3);
    await assert.rejects(
      request("open", { shift_id: vacancy.id }),
      /overstaffing/,
    );
    await as(0);
    assert.deepEqual(
      await row("select * from public.published_shifts where id=$1", [
        vacancy.id,
      ]),
      vacancy,
    );
    assert.equal(
      (
        await row(
          "select count(*)::int n from public.shifts where shift_group_id=$1 and employee_id is not null",
          [volunteerGroup.id],
        )
      ).n,
      1,
    );
  } finally {
    await db.close();
  }
});
