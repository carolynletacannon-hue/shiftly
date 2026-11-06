import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("time off: tenant isolation, roster ownership, lifecycle, conflicts and notification privacy", async (t) => {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;`);
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const migration = files.find((f) => f.includes("phase3_time_off"))!;
  for (const f of files.filter((f) => f < migration))
    await db.exec(await readFile(new URL(f, dir), "utf8"));
  const ids = Array.from(
    { length: 5 },
    (_, i) => `30000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
  );
  for (const [i, id] of ids.entries())
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
      [id, `timeoff${i}@example.test`],
    );
  async function as(i: number) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      ids[i],
    ]);
    await db.exec("set role authenticated");
  }
  async function one(sql: string, args: unknown[] = []) {
    return (await db.query<Record<string, any>>(sql, args)).rows[0];
  }
  async function off(org: string, command: string, payload: object) {
    return (
      await one("select public.time_off_command($1,$2,$3::jsonb) r", [
        org,
        command,
        JSON.stringify(payload),
      ])
    ).r;
  }
  async function schedule(
    org: string,
    command: string,
    payload: object,
    revision: number | null = null,
  ) {
    return (
      await one("select public.schedule_command($1,$2,$3::jsonb,$4) r", [
        org,
        command,
        JSON.stringify(payload),
        revision,
      ])
    ).r;
  }
  await as(0);
  const org = (
    await one(
      "select public.create_workspace('Time Off Test','America/Denver') id",
    )
  ).id;
  const week = await schedule(org, "create", { week_start: "2026-11-08" });
  let draft = await schedule(
    org,
    "save",
    {
      schedule_id: week.id,
      employee_id: ids[0],
      starts_at: "2026-11-08T16:00:00Z",
      ends_at: "2026-11-08T20:00:00Z",
    },
    1,
  );
  await schedule(org, "publish", { schedule_id: week.id }, draft.revision);
  await db.exec("reset role");
  await db.query(
    "insert into public.memberships values($1,$2,'manager'),($1,$3,'employee'),($1,$4,'employee')",
    [org, ids[1], ids[2], ids[3]],
  );
  const placeholder = (
    await one(
      "insert into public.employees(organization_id,display_name) values($1,'Sample Placeholder') returning id",
      [org],
    )
  ).id;
  // Employee id intentionally differs from auth id, as after a placeholder invite.
  const linkedId = "40000000-0000-0000-0000-000000000001";
  await db.query(
    "update public.employees set id=$1 where organization_id=$2 and user_id=$3",
    [linkedId, org, ids[2]],
  );
  const snapshots: Record<string, unknown> = {};
  for (const table of [
    "shifts",
    "published_shifts",
    "memberships",
    "employees",
    "invitations",
  ])
    snapshots[table] = (
      await db.query(`select * from public.${table} order by 1,2`)
    ).rows;
  await db.exec(await readFile(new URL(migration, dir), "utf8"));
  for (const table of Object.keys(snapshots))
    assert.deepEqual(
      (await db.query(`select * from public.${table} order by 1,2`)).rows,
      snapshots[table],
    );
  await as(4);
  const other = (
    await one(
      "select public.create_workspace('Other Tenant','America/Denver') id",
    )
  ).id;
  const full = {
    employee_id: linkedId,
    start_date: "2026-11-08",
    end_date: "2026-11-09",
    full_day: true,
    notes: "Fictional private note",
  };
  let request: string;
  await t.test(
    "employees submit only for their linked roster identity and cannot escalate status",
    async () => {
      await as(2);
      request = (
        await off(org, "submit", {
          ...full,
          status: "approved",
          created_by: ids[0],
        })
      ).id;
      assert.equal(
        (
          await one("select status from public.time_off_requests where id=$1", [
            request,
          ])
        ).status,
        "pending",
      );
      await assert.rejects(
        off(org, "submit", { ...full, employee_id: ids[3] }),
        /own/,
      );
      await assert.rejects(
        off(org, "submit", { ...full, employee_id: placeholder }),
        /own/,
      );
      await assert.rejects(
        off(org, "submit", { ...full, employee_id: ids[2] }),
        /Employee unavailable/,
      );
      await assert.rejects(off(org, "manual", full), /placeholder/);
      await assert.rejects(off(org, "approve", { id: request }), /permission/);
      await assert.rejects(
        db.query(
          "update public.time_off_requests set status='approved' where id=$1",
          [request],
        ),
        /permission/,
      );
      await assert.rejects(
        db.query("delete from public.time_off_requests where id=$1", [request]),
        /permission/,
      );
      assert.equal(
        (await one("select count(*)::int n from public.time_off_notifications"))
          .n,
        0,
      );
      await assert.rejects(
        db.query("select * from public.claim_time_off_email($1)", [request]),
        /permission/,
      );
    },
  );
  await t.test(
    "other employees and tenants cannot read private records or act on ids",
    async () => {
      for (const i of [3, 4]) {
        await as(i);
        assert.equal(
          (await one("select count(*)::int n from public.time_off_requests")).n,
          0,
        );
        await assert.rejects(off(org, "cancel", { id: request }));
        await assert.rejects(off(other, "approve", { id: request }));
        await assert.rejects(off(other, "submit", full));
      }
    },
  );
  await t.test(
    "manager approval commits a private employee notification and freezes decision",
    async () => {
      await as(1);
      assert.equal(
        (
          await one("select notes from public.time_off_requests where id=$1", [
            request,
          ])
        ).notes,
        full.notes,
      );
      assert.equal(
        (
          await one(
            "select count(*)::int n from public.time_off_notifications where event='submitted'",
          )
        ).n,
        1,
      );
      await off(org, "approve", { id: request });
      await assert.rejects(
        off(org, "deny", { id: request }),
        /already reviewed/,
      );
      await as(2);
      assert.equal(
        (
          await one("select status from public.time_off_requests where id=$1", [
            request,
          ])
        ).status,
        "approved",
      );
      assert.equal(
        (await one("select event from public.time_off_notifications")).event,
        "approved",
      );
      await assert.rejects(
        off(org, "cancel", { id: request }),
        /already reviewed/,
      );
    },
  );
  await t.test(
    "approval of existing assignments preserves published data and supports repair one at a time",
    async () => {
      await as(0);
      const own = (await off(org, "submit", { ...full, employee_id: ids[0] }))
        .id;
      await off(org, "approve", { id: own });
      const shifts = (
        await db.query<{ id: string }>(
          "select id from public.shifts where schedule_id=$1",
          [week.id],
        )
      ).rows;
      draft = await schedule(
        org,
        "save",
        {
          id: shifts[0].id,
          schedule_id: week.id,
          employee_id: ids[0],
          starts_at: "2026-11-08T16:00:00Z",
          ends_at: "2026-11-08T20:00:00Z",
          notes: "Edited note",
        },
        draft.revision,
      );
      await assert.rejects(
        schedule(org, "publish", { schedule_id: week.id }, draft.revision),
        /Approved time off/,
      );
      assert.deepEqual(
        (await db.query("select * from public.published_shifts order by 1,2"))
          .rows,
        snapshots.published_shifts,
      );
      draft = await schedule(
        org,
        "assign",
        { schedule_id: week.id, id: shifts[0].id, employee_id: "" },
        draft.revision,
      );
      await schedule(org, "publish", { schedule_id: week.id }, draft.revision);
    },
  );
  await t.test(
    "approved time off blocks assignments and partial periods use exclusive end boundaries",
    async () => {
      await as(1);
      const partial = (
        await off(org, "manual", {
          employee_id: placeholder,
          start_date: "2026-11-10",
          end_date: "2026-11-10",
          full_day: false,
          starts_at: "2026-11-10T17:00:00Z",
          ends_at: "2026-11-10T19:00:00Z",
        })
      ).id;
      await assert.rejects(
        schedule(
          org,
          "save",
          {
            schedule_id: week.id,
            employee_id: placeholder,
            starts_at: "2026-11-10T18:00:00Z",
            ends_at: "2026-11-10T20:00:00Z",
          },
          draft.revision,
        ),
        /Approved time off/,
      );
      draft = await schedule(
        org,
        "save",
        {
          schedule_id: week.id,
          employee_id: placeholder,
          starts_at: "2026-11-10T19:00:00Z",
          ends_at: "2026-11-10T21:00:00Z",
        },
        draft.revision,
      );
      await assert.rejects(
        schedule(
          org,
          "save",
          {
            schedule_id: week.id,
            employee_id: linkedId,
            starts_at: "2026-11-09T17:00:00Z",
            ends_at: "2026-11-09T19:00:00Z",
          },
          draft.revision,
        ),
        /Approved time off/,
      );
      await off(org, "remove_manual", { id: partial });
      assert.equal(
        (
          await one("select status from public.time_off_requests where id=$1", [
            partial,
          ])
        ).status,
        "cancelled",
      );
    },
  );
  await t.test("denials, cancellations and invalid requests", async () => {
    await as(2);
    const pending = (
      await off(org, "submit", {
        ...full,
        start_date: "2026-11-12",
        end_date: "2026-11-12",
      })
    ).id;
    await off(org, "cancel", { id: pending });
    await as(0);
    await assert.rejects(
      off(org, "approve", { id: pending }),
      /already reviewed/,
    );
    await as(2);
    const denied = (await off(org, "submit", full)).id;
    await as(1);
    await off(org, "deny", { id: denied });
    await as(2);
    assert.equal(
      (
        await one("select status from public.time_off_requests where id=$1", [
          denied,
        ])
      ).status,
      "denied",
    );
    assert.equal(
      (
        await one(
          "select count(*)::int n from public.time_off_notifications where event='denied'",
        )
      ).n,
      1,
    );
    await assert.rejects(
      off(org, "submit", { ...full, end_date: "2026-11-07" }),
    );
    await assert.rejects(
      off(org, "submit", { ...full, notes: "x".repeat(1001) }),
    );
    await assert.rejects(
      off(org, "submit", {
        ...full,
        full_day: false,
        starts_at: "2026-11-08T17:00:00Z",
        ends_at: "2026-11-08T16:00:00Z",
        end_date: "2026-11-08",
      }),
    );
  });
  await t.test(
    "availability ownership, atomic replacement, privacy, and advisory scheduling",
    async () => {
      await as(2);
      const days = [
        { weekday: 0, unavailable: true },
        {
          weekday: 2,
          unavailable: false,
          start_time: "09:00",
          end_time: "17:00",
        },
      ];
      await off(org, "availability", { employee_id: linkedId, days });
      await assert.rejects(
        off(org, "availability", {
          employee_id: linkedId,
          days: [{ weekday: 8, unavailable: true }],
        }),
      );
      assert.equal(
        (await one("select count(*)::int n from public.employee_availability"))
          .n,
        2,
      );
      await assert.rejects(
        db.query("delete from public.employee_availability"),
        /permission/,
      );
      await as(3);
      assert.equal(
        (await one("select count(*)::int n from public.employee_availability"))
          .n,
        0,
      );
      await assert.rejects(
        off(org, "availability", { employee_id: linkedId, days: [] }),
      );
      await as(4);
      assert.equal(
        (await one("select count(*)::int n from public.employee_availability"))
          .n,
        0,
      );
      await as(1);
      assert.equal(
        (await one("select count(*)::int n from public.employee_availability"))
          .n,
        2,
      );
      // Tuesday outside the stated 9–5 preference is still assignable.
      draft = await schedule(
        org,
        "save",
        {
          schedule_id: week.id,
          employee_id: linkedId,
          starts_at: "2026-11-10T13:00:00Z",
          ends_at: "2026-11-10T15:00:00Z",
        },
        draft.revision,
      );
      await as(2);
      await off(org, "availability", { employee_id: linkedId, days: [] });
      assert.equal(
        (await one("select count(*)::int n from public.employee_availability"))
          .n,
        0,
      );
    },
  );
  await t.test(
    "full days use local midnight across DST; worker can claim once without exposing addresses",
    async () => {
      await as(2);
      const dst = (
        await off(org, "submit", {
          ...full,
          start_date: "2026-11-01",
          end_date: "2026-11-01",
        })
      ).id;
      const row = await one(
        "select extract(epoch from ends_at-starts_at)/3600 hours from public.time_off_requests where id=$1",
        [dst],
      );
      assert.equal(Number(row.hours), 25);
      await db.exec("reset role; set role service_role");
      const claimed = (
        await db.query<{ id: string; email: string }>(
          "select * from public.claim_time_off_email($1)",
          [dst],
        )
      ).rows;
      assert.equal(claimed.length, 2);
      assert.deepEqual(claimed.map((c) => c.email).sort(), [
        "timeoff0@example.test",
        "timeoff1@example.test",
      ]);
      assert.equal(
        (await db.query("select * from public.claim_time_off_email($1)", [dst]))
          .rows.length,
        0,
      );
      for (const n of claimed)
        await db.query("select public.finish_time_off_email($1,'failed')", [
          n.id,
        ]);
      await as(2);
      assert.equal(
        (
          await one("select status from public.time_off_requests where id=$1", [
            dst,
          ])
        ).status,
        "pending",
      );
      await db.exec("reset role; set role service_role");
      const decisionEmails = (
        await db.query<{ id: string; email: string; event: string }>(
          "select * from public.claim_time_off_email($1)",
          [request],
        )
      ).rows;
      assert.equal(decisionEmails.length, 1);
      assert.equal(decisionEmails[0].email, "timeoff2@example.test");
      assert.equal(decisionEmails[0].event, "approved");
      await db.query("select public.finish_time_off_email($1,'failed')", [
        decisionEmails[0].id,
      ]);
      await as(2);
      assert.equal(
        (
          await one("select status from public.time_off_requests where id=$1", [
            request,
          ])
        ).status,
        "approved",
      );
      await db.exec(
        "reset role; select set_config('request.jwt.claim.sub','',false); set role anon",
      );
      await assert.rejects(
        db.query("select * from public.time_off_requests"),
        /permission/,
      );
      await assert.rejects(off(org, "submit", full), /permission/);
      await assert.rejects(
        db.query("select * from public.claim_time_off_email($1)", [dst]),
        /permission/,
      );
    },
  );
  await t.test(
    "a later verified invitation links to the same placeholder and preserves approved time off",
    async () => {
      await as(1);
      const manual = (
        await off(org, "manual", {
          employee_id: placeholder,
          start_date: "2026-11-11",
          end_date: "2026-11-11",
          full_day: true,
        })
      ).id;
      const digest = "a".repeat(64);
      await db.query("select public.issue_roster_invitation($1,$2,$3,$4)", [
        org,
        placeholder,
        "timeoff4@example.test",
        digest,
      ]);
      await as(4);
      await db.query("select public.accept_invitation($1)", [digest]);
      assert.equal(
        (
          await one(
            "select id from public.employees where organization_id=$1 and user_id=$2",
            [org, ids[4]],
          )
        ).id,
        placeholder,
      );
      const preserved = await one(
        "select employee_id,status from public.time_off_requests where id=$1",
        [manual],
      );
      assert.equal(preserved.employee_id, placeholder);
      assert.equal(preserved.status, "approved");
      await assert.rejects(
        off(org, "cancel", { id: manual }),
        /already reviewed/,
      );
      const ownRequest = await off(org, "submit", {
        ...full,
        employee_id: placeholder,
      });
      await off(org, "cancel", { id: ownRequest.id });
      await as(1);
      await assert.rejects(
        off(org, "remove_manual", { id: manual }),
        /unavailable/,
      );
    },
  );
  await db.close();
});
