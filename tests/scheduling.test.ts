import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  addDays,
  copyTimes,
  hoursInWeek,
  localInput,
  localToInstant,
  weekStart,
  weekBounds,
} from "../lib/scheduling/time";

test("IANA timezones, overnight durations, DST ambiguity and week boundaries", () => {
  const tz = "America/Denver";
  const shift = (start: string, end: string) => ({
    starts_at: localToInstant(start, tz),
    ends_at: localToInstant(end, tz),
  });
  const fall = shift("2026-10-31T23:00", "2026-11-01T07:00");
  assert.equal(
    (Date.parse(fall.ends_at) - Date.parse(fall.starts_at)) / 3600000,
    9,
  );
  assert.equal(hoursInWeek([fall], "2026-10-25", tz), 1);
  assert.equal(hoursInWeek([fall], "2026-11-01", tz), 8);
  const spring = shift("2026-03-07T23:00", "2026-03-08T07:00");
  assert.equal(
    (Date.parse(spring.ends_at) - Date.parse(spring.starts_at)) / 3600000,
    7,
  );
  assert.throws(() => localToInstant("2026-03-08T02:30", tz));
  assert.throws(() => localToInstant("2026-03-08T02:30", tz, "earlier"));
  assert.throws(() => localToInstant("2026-03-08T02:30", tz, "later"));
  assert.throws(() => localToInstant("2026-11-01T01:30", tz));
  assert.equal(
    Date.parse(localToInstant("2026-11-01T01:30", tz, "later")) -
      Date.parse(localToInstant("2026-11-01T01:30", tz, "earlier")),
    3600000,
  );
  const copied = copyTimes(
    shift("2026-03-01T07:00", "2026-03-01T15:00"),
    "2026-03-01",
    "2026-03-08",
    tz,
    tz,
  );
  assert.equal(localInput(copied.starts_at, tz), "2026-03-08T07:00");
  assert.equal(hoursInWeek([copied], "2026-03-08", tz), 8);
  assert.equal(weekStart("2026-11-05", 0), "2026-11-01");
  assert.equal(weekStart("2026-11-05", 1), "2026-11-02");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(
    (Date.parse(weekBounds("2026-11-01", tz).end) -
      Date.parse(weekBounds("2026-11-01", tz).start)) /
      3600000,
    169,
  );
});

test("persistent scheduling authorization, publication and concurrency on Postgres", async (t) => {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;`);
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await readFile(new URL(file, dir), "utf8"));
  const ids = [1, 2, 3, 4, 5].map(
    (i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  );
  for (const [index, id] of ids.entries())
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
      [id, `schedule${index}@example.test`],
    );
  async function as(index: number) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      ids[index],
    ]);
    await db.exec("set role authenticated");
  }
  async function value<T = { id: string }>(sql: string, args: unknown[] = []) {
    return (await db.query<T>(sql, args)).rows[0];
  }
  async function command(
    org: string,
    name: string,
    payload: object,
    revision: number | null = null,
  ) {
    return (
      await value<{ result: { id: string; revision: number } }>(
        "select public.schedule_command($1,$2,$3::jsonb,$4) as result",
        [org, name, JSON.stringify(payload), revision],
      )
    ).result;
  }
  await as(0);
  const org = (
    await value(
      "select public.create_workspace('Sample Hotel','America/Denver') as id",
    )
  ).id;
  await as(3);
  const other = (
    await value("select public.create_workspace('Another Hotel','UTC') as id")
  ).id;
  await db.exec("reset role");
  await db.query(
    "insert into public.memberships values($1,$2,'manager'),($1,$3,'employee'),($4,$5,'employee')",
    [org, ids[1], ids[2], other, ids[4]],
  );
  await as(0);
  const position = (await command(org, "position", { name: "Front desk" })).id;
  const foreignPosition = (
    await (async () => {
      await as(3);
      const p = await command(other, "position", { name: "Foreign position" });
      await as(0);
      return p;
    })()
  ).id;
  const week = "2026-11-01";
  const schedule = await command(org, "create", { week_start: week });
  let revision = schedule.revision;
  const shift = (
    day: string,
    start = "07:00",
    end = "15:00",
    employee = ids[2],
  ) => ({
    schedule_id: schedule.id,
    employee_id: employee,
    position_id: position,
    starts_at: localToInstant(`${day}T${start}`, "America/Denver"),
    ends_at: localToInstant(`${day}T${end}`, "America/Denver"),
    notes: "Front desk coverage",
  });
  let firstId = "";
  try {
    await t.test(
      "existing accounts/workspaces are preserved; defaults are created per workspace",
      async () => {
        assert.equal(
          (
            await value<{ count: number }>(
              "select count(*)::integer as count from public.memberships where organization_id=$1",
              [org],
            )
          ).count,
          3,
        );
        assert.equal(
          (
            await db.query(
              "select * from public.shift_templates where organization_id=$1",
              [org],
            )
          ).rows.length,
          3,
        );
        await assert.rejects(
          command(org, "create", { week_start: week }),
          /draft already exists/,
        );
        await assert.rejects(
          command(org, "create", { week_start: "2026-11-02" }),
          /workspace week start/,
        );
      },
    );
    await t.test(
      "employees cannot read drafts or write; unrelated tenants cannot read any schedule data",
      async () => {
        await as(2);
        for (const table of [
          "schedules",
          "shifts",
          "shift_templates",
          "schedule_events",
          "schedule_settings",
        ])
          assert.equal(
            (
              await db.query(
                `select * from public.${table} where organization_id=$1`,
                [org],
              )
            ).rows.length,
            0,
          );
        await assert.rejects(
          command(org, "save", shift(week), revision),
          /permission denied/,
        );
        await assert.rejects(
          command(org, "publish", { schedule_id: schedule.id }, revision),
          /permission denied/,
        );
        await assert.rejects(
          db.query("insert into public.shifts(organization_id) values($1)", [
            org,
          ]),
        );
        await as(3);
        assert.equal(
          (
            await db.query(
              "select * from public.schedules where organization_id=$1",
              [org],
            )
          ).rows.length,
          0,
        );
        await assert.rejects(
          command(org, "publish", { schedule_id: schedule.id }, revision),
          /permission denied/,
        );
        await assert.rejects(
          command(other, "publish", { schedule_id: schedule.id }, revision),
          /Schedule unavailable/,
        );
        await as(0);
      },
    );
    await t.test(
      "managers can save; overlaps/end times and foreign assignments are rejected atomically",
      async () => {
        await as(1);
        const saved = await command(org, "save", shift(week), revision);
        revision = saved.revision;
        firstId = saved.id;
        await assert.rejects(
          command(org, "save", shift(week, "14:00", "22:00"), revision),
          /overlapping/,
        );
        await assert.rejects(
          command(org, "save", shift(week, "16:00", "15:00"), revision),
        );
        await assert.rejects(
          command(org, "save", shift(week, "15:00", "23:00", ids[4]), revision),
        );
        await assert.rejects(
          command(
            org,
            "save",
            { ...shift(week, "15:00", "23:00"), position_id: foreignPosition },
            revision,
          ),
        );
        assert.equal(
          (
            await value<{ revision: number }>(
              "select revision from public.schedules where id=$1",
              [schedule.id],
            )
          ).revision,
          revision,
        );
        const adjacent = await command(
          org,
          "save",
          shift(week, "15:00", "23:00"),
          revision,
        );
        revision = adjacent.revision;
        const parallel = await command(
          org,
          "save",
          shift(week, "07:00", "15:00", ids[1]),
          revision,
        );
        revision = parallel.revision;
        await assert.rejects(
          db.query("update public.shifts set notes='bypass' where id=$1", [
            firstId,
          ]),
        );
      },
    );
    await t.test(
      "publish is explicit, atomic, revision-checked, and creates an event without email",
      async () => {
        await as(2);
        assert.equal(
          (
            await db.query(
              "select * from public.published_shifts where organization_id=$1",
              [org],
            )
          ).rows.length,
          0,
        );
        await as(1);
        await assert.rejects(
          command(org, "publish", { schedule_id: schedule.id }, revision - 1),
          /Stale revision/,
        );
        await command(org, "publish", { schedule_id: schedule.id }, revision);
        assert.equal(
          (
            await db.query(
              "select * from public.schedule_events where organization_id=$1",
              [org],
            )
          ).rows.length,
          1,
        );
        await assert.rejects(
          command(org, "publish", { schedule_id: schedule.id }, revision),
          /No unpublished changes/,
        );
        await as(2);
        assert.equal(
          (
            await db.query(
              "select * from public.published_shifts where organization_id=$1",
              [org],
            )
          ).rows.length,
          3,
        );
        assert.equal(
          (
            await db.query(
              "select * from public.shifts where organization_id=$1",
              [org],
            )
          ).rows.length,
          0,
        );
        assert.equal(
          (
            await db.query(
              "select * from public.schedule_events where organization_id=$1",
              [org],
            )
          ).rows.length,
          0,
        );
        await as(3);
        assert.equal(
          (
            await db.query(
              "select * from public.published_shifts where organization_id=$1",
              [org],
            )
          ).rows.length,
          0,
        );
        await as(1);
      },
    );
    await t.test(
      "edits, reassignments and deletes remain private until explicit republish",
      async () => {
        const saved = await command(
          org,
          "save",
          {
            ...shift(week, "08:00", "14:00", ids[0]),
            id: firstId,
            notes: "Revised draft",
          },
          revision,
        );
        revision = saved.revision;
        await as(2);
        const before = await value<{ employee_id: string; notes: string }>(
          "select employee_id,notes from public.published_shifts where id=$1",
          [firstId],
        );
        assert.equal(before.employee_id, ids[2]);
        assert.equal(before.notes, "Front desk coverage");
        await as(1);
        await command(org, "publish", { schedule_id: schedule.id }, revision);
        await as(2);
        const after = await value<{ employee_id: string; notes: string }>(
          "select employee_id,notes from public.published_shifts where id=$1",
          [firstId],
        );
        assert.equal(after.employee_id, ids[0]);
        assert.equal(after.notes, "Revised draft");
        await as(1);
        const removed = await command(
          org,
          "delete",
          { schedule_id: schedule.id, id: firstId },
          revision,
        );
        revision = removed.revision;
        assert.equal(
          (
            await db.query(
              "select * from public.published_shifts where id=$1",
              [firstId],
            )
          ).rows.length,
          1,
        );
        await command(org, "publish", { schedule_id: schedule.id }, revision);
        assert.equal(
          (
            await db.query(
              "select * from public.published_shifts where id=$1",
              [firstId],
            )
          ).rows.length,
          0,
        );
      },
    );
    await t.test(
      "competing edits with the same revision have one winner and no stale overwrite",
      async () => {
        const results = await Promise.allSettled([
          command(org, "save", shift("2026-11-02"), revision),
          command(org, "save", shift("2026-11-03"), revision),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const rejected = results.find(
          (r) => r.status === "rejected",
        ) as PromiseRejectedResult;
        assert.match(String(rejected.reason), /Stale revision/);
        revision++;
      },
    );
    await t.test(
      "publication rechecks conflicts and leaves the live snapshot intact on failure",
      async () => {
        const before = await value<{ count: number }>(
          "select count(*)::integer as count from public.published_shifts where schedule_id=$1",
          [schedule.id],
        );
        await db.exec("reset role");
        // Simulate invalid data from a privileged future integration, not a normal client write.
        const injected = await value(
          "insert into public.shifts(organization_id,schedule_id,employee_id,starts_at,ends_at) values($1,$2,$3,$4,$5) returning id",
          [
            org,
            schedule.id,
            ids[2],
            localToInstant(week + "T16:00", "America/Denver"),
            localToInstant(week + "T17:00", "America/Denver"),
          ],
        );
        await as(1);
        await assert.rejects(
          command(org, "publish", { schedule_id: schedule.id }, revision),
          /overlapping/,
        );
        assert.equal(
          (
            await value<{ count: number }>(
              "select count(*)::integer as count from public.published_shifts where schedule_id=$1",
              [schedule.id],
            )
          ).count,
          before.count,
        );
        await db.exec("reset role");
        await db.query("delete from public.shifts where id=$1", [injected.id]);
        await as(1);
      },
    );
    await t.test(
      "overnight and cross-week conflicts are enforced, including published adjacent weeks",
      async () => {
        const previous = await command(org, "create", {
          week_start: "2026-10-25",
        });
        const overnight = await command(
          org,
          "save",
          {
            ...shift("2026-10-31", "23:00", "23:30", ids[0]),
            schedule_id: previous.id,
            ends_at: localToInstant("2026-11-01T07:00", "America/Denver"),
          },
          previous.revision,
        );
        await command(
          org,
          "publish",
          { schedule_id: previous.id },
          overnight.revision,
        );
        await assert.rejects(
          command(org, "save", shift(week, "06:00", "08:00", ids[0]), revision),
          /overlapping/,
        );
        const adjacent = await command(
          org,
          "save",
          shift(week, "07:00", "08:00", ids[0]),
          revision,
        );
        revision = adjacent.revision;
        await assert.rejects(
          command(
            org,
            "save",
            {
              ...shift("2026-11-03"),
              ends_at: localToInstant("2026-11-05T08:00", "America/Denver"),
            },
            revision,
          ),
        );
        await assert.rejects(
          command(org, "save", shift("2026-11-08"), revision),
          /start in this week/,
        );
        // Move the previous draft away: its published overnight still prevents overlap.
        await command(
          org,
          "delete",
          { schedule_id: previous.id, id: overnight.id },
          overnight.revision,
        );
        await assert.rejects(
          command(org, "save", shift(week, "06:00", "07:00", ids[0]), revision),
          /overlapping/,
        );
        await as(2);
        assert.equal(
          (
            await db.query(
              "select * from public.published_shifts where schedule_id=$1",
              [previous.id],
            )
          ).rows.length,
          1,
        );
        await as(1);
      },
    );
    await t.test(
      "copy creates a new independent draft and rolls back invalid copied shifts",
      async () => {
        const rows = (
          await db.query<{
            employee_id: string;
            position_id: string | null;
            starts_at: string;
            ends_at: string;
            notes: string;
          }>("select * from public.shifts where schedule_id=$1", [schedule.id])
        ).rows;
        const copied = rows.map((s) => ({
          ...s,
          ...copyTimes(
            {
              starts_at: new Date(s.starts_at).toISOString(),
              ends_at: new Date(s.ends_at).toISOString(),
            },
            week,
            "2026-11-08",
            "America/Denver",
            "America/Denver",
          ),
        }));
        const next = await command(org, "create", {
          week_start: "2026-11-08",
          shifts: copied,
        });
        assert.equal(
          (
            await db.query("select * from public.shifts where schedule_id=$1", [
              next.id,
            ])
          ).rows.length,
          rows.length,
        );
        assert.equal(
          (
            await db.query(
              "select * from public.published_schedules where id=$1",
              [next.id],
            )
          ).rows.length,
          0,
        );
        await assert.rejects(
          command(org, "create", {
            week_start: "2026-11-15",
            shifts: [{ ...copied[0], employee_id: ids[4] }],
          }),
        );
        assert.equal(
          (
            await db.query(
              "select * from public.schedules where organization_id=$1 and week_start='2026-11-15'",
              [org],
            )
          ).rows.length,
          0,
        );
      },
    );
    await t.test(
      "templates and workload guideline persist with revision checks",
      async () => {
        const template = await command(org, "template_save", {
          name: "Night audit",
          start_time: "23:00",
          end_time: "07:00",
          end_next_day: true,
          position_id: position,
        });
        await command(
          org,
          "template_save",
          {
            id: template.id,
            name: "Night audit",
            start_time: "22:00",
            end_time: "06:00",
            end_next_day: true,
            position_id: position,
          },
          1,
        );
        await assert.rejects(
          command(org, "template_delete", { id: template.id }, 1),
          /Stale revision/,
        );
        await command(org, "template_delete", { id: template.id }, 2);
        await command(org, "settings", { weekly_hours_warning: 36 }, 1);
        await assert.rejects(
          command(org, "settings", { weekly_hours_warning: 40 }, 1),
          /Stale revision/,
        );
        assert.equal(
          Number(
            (
              await value<{ weekly_hours_warning: number }>(
                "select weekly_hours_warning from public.schedule_settings where organization_id=$1",
                [org],
              )
            ).weekly_hours_warning,
          ),
          36,
        );
        await assert.rejects(
          command(org, "settings", { weekly_hours_warning: -1 }, 2),
        );
      },
    );
    await t.test(
      "every new table has RLS and scheduling functions have narrow grants",
      async () => {
        await db.exec("reset role");
        const tables = [
          "schedules",
          "shifts",
          "published_schedules",
          "published_shifts",
          "shift_templates",
          "schedule_settings",
          "schedule_events",
        ];
        for (const table of tables) {
          const row = await value<{ relrowsecurity: boolean }>(
            "select relrowsecurity from pg_class where oid=$1::regclass",
            [`public.${table}`],
          );
          assert.equal(row.relrowsecurity, true);
          const rights = await value<{ writes: boolean }>(
            "select has_table_privilege('authenticated',$1,'INSERT,UPDATE,DELETE') as writes",
            [`public.${table}`],
          );
          assert.equal(rights.writes, false);
        }
        const rights = await value<{ allowed: boolean }>(
          "select has_function_privilege('anon','public.schedule_command(uuid,text,jsonb,integer)','EXECUTE') as allowed",
        );
        assert.equal(rights.allowed, false);
        await as(1);
      },
    );
    await t.test(
      "anonymous calls and direct snapshot writes are denied",
      async () => {
        await assert.rejects(
          db.query(
            "delete from public.published_shifts where organization_id=$1",
            [org],
          ),
        );
        await db.exec("reset role; set role anon");
        await assert.rejects(db.query("select * from public.schedules"));
        await assert.rejects(
          command(org, "publish", { schedule_id: schedule.id }, revision),
        );
      },
    );
  } finally {
    await db.close();
  }
});
