import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { migrationDatabase } from "./support/migration-database";

test("calendar PostgreSQL: grants, publication snapshots, lifecycle, isolation, reconciliation and rate limits", async (t) => {
  const db = await migrationDatabase();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon,service_role;
      grant execute on function auth.uid() to authenticated,anon,service_role;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files.filter((f) => !f.includes("phase6_calendar")))
      await db.exec(await readFile(new URL(file, dir), "utf8"));
    const users = Array.from(
      { length: 4 },
      (_, i) => `b0000000-0000-0000-0000-00000000000${i + 1}`,
    );
    for (const [i, user] of users.entries())
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [user, `calendar${i}@example.test`],
      );
    const row = async (sql: string, args: unknown[] = []): Promise<any> =>
      (await db.query(sql, args)).rows[0];
    const as = async (i: number) => {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        users[i],
      ]);
      await db.exec("set role authenticated");
    };
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    await as(0);
    const org = (
      await row(
        "select public.create_workspace('Calendar Alpha','America/Denver') id",
      )
    ).id;
    await as(3);
    const other = (
      await row(
        "select public.create_workspace('Calendar Beta','Asia/Tokyo') id",
      )
    ).id;
    await db.exec("reset role");
    await db.query(
      "insert into public.memberships values($1,$2,'employee'),($1,$3,'employee'),($4,$2,'employee')",
      [org, users[1], users[2], other],
    );
    const command = async (name: string, payload: object, workspace = org) => {
      const revision =
        "schedule_id" in payload
          ? (
              await row("select revision from public.schedules where id=$1", [
                (payload as { schedule_id: string }).schedule_id,
              ])
            ).revision
          : null;
      return (
        await row("select public.schedule_command($1,$2,$3,$4) r", [
          workspace,
          name,
          JSON.stringify(payload),
          revision,
        ])
      ).r;
    };
    await as(0);
    const schedule = await command("create", { week_start: "2027-01-03" });
    const group = await command("group_save", {
      schedule_id: schedule.id,
      employee_id: users[1],
      label: "Night desk",
      starts_at: "2027-01-04T04:00:00Z",
      ends_at: "2027-01-04T12:00:00Z",
      notes: "Employee visible",
      required_count: 2,
    });
    await command("group_assign", {
      schedule_id: schedule.id,
      shift_group_id: group.id,
      employee_id: users[2],
    });
    await command("publish", { schedule_id: schedule.id });
    const original = (
      await row(
        "select id from public.published_shifts where schedule_id=$1 and employee_id=$2",
        [schedule.id, users[1]],
      )
    ).id;
    await as(3);
    const historical = await command(
      "create",
      { week_start: "2025-01-05" },
      other,
    );
    await command(
      "group_save",
      {
        schedule_id: historical.id,
        employee_id: users[1],
        label: "Historical Tokyo shift",
        starts_at: "2025-01-05T00:00:00Z",
        ends_at: "2025-01-05T08:00:00Z",
        required_count: 1,
      },
      other,
    );
    await command("publish", { schedule_id: historical.id }, other);
    await as(0);
    // Upgrade with real pre-existing published data; backfill cannot consult drafts.
    await command("group_save", {
      schedule_id: schedule.id,
      shift_group_id: group.id,
      label: "Unpublished secret",
      starts_at: "2027-01-04T04:00:00Z",
      ends_at: "2027-01-04T12:00:00Z",
      notes: "Draft secret",
    });
    await db.exec("reset role");
    for (const file of files.filter((f) => f.includes("phase6_calendar")))
      await db.exec(await readFile(new URL(file, dir), "utf8"));
    const manage = async (
      cmd: string,
      digest: string | null = null,
      workspace = org,
    ) =>
      (
        await row("select public.manage_calendar_subscription($1,$2,$3) r", [
          workspace,
          cmd,
          digest,
        ])
      ).r;
    const feed = async (digest = hash("alpha"), bucket = 0) => {
      await db.exec("reset role;set role service_role");
      return (
        await row("select public.read_calendar_feed($1,$2) r", [digest, bucket])
      ).r;
    };
    await t.test(
      "empty published calendar is valid for a connected employee without shifts",
      async () => {
        await as(0);
        await manage("rotate", hash("empty-owner"));
        assert.deepEqual((await feed(hash("empty-owner"))).events, []);
      },
    );
    await t.test(
      "role grants and RLS prevent roster/hash access, direct mutation and anonymous feed RPC",
      async () => {
        await as(1);
        for (const table of [
          "calendar_subscriptions",
          "calendar_events",
          "calendar_request_buckets",
        ])
          await assert.rejects(
            db.query(`select * from shiftly_private.${table}`),
          );
        await assert.rejects(
          db.query("select public.read_calendar_feed($1,0)", [hash("alpha")]),
        );
        await assert.rejects(
          db.query("select shiftly_private.sync_calendar_event($1,$2,$3)", [
            org,
            users[1],
            original,
          ]),
        );
        await db.exec("reset role;set role anon");
        await assert.rejects(manage("rotate", hash("bad")));
        await assert.rejects(
          db.query("select public.read_calendar_feed($1,0)", [hash("alpha")]),
        );
      },
    );
    await t.test(
      "valid token sees only own published shared assignment, never drafts or coworker",
      async () => {
        await as(1);
        assert.equal((await manage("status")).active, false);
        await manage("rotate", hash("alpha"));
        const f = await feed();
        assert.equal(f.status, "ok");
        assert.equal(f.events.length, 1);
        assert.equal(f.events[0].employee_id, users[1]);
        assert.equal(f.events[0].details.label, "Night desk");
        assert.equal(f.events[0].details.notes, "Employee visible");
        assert.ok(!JSON.stringify(f).includes("secret"));
        assert.equal(f.events[0].sequence, 0);
      },
    );
    await t.test(
      "employee color edits preserve published snapshots and calendar subscriptions",
      async () => {
        await db.exec("reset role");
        const before = (
          await row(
            "select jsonb_agg(to_jsonb(p) order by id) v from public.published_shifts p where schedule_id=$1",
            [schedule.id],
          )
        ).v;
        await as(0);
        await db.query(
          "update public.employees set color_key='teal' where organization_id=$1 and id=$2",
          [org, users[1]],
        );
        await as(1);
        assert.equal((await manage("status")).active, true);
        const unchangedFeed = await feed();
        assert.equal(unchangedFeed.status, "ok");
        assert.equal(unchangedFeed.events[0].sequence, 0);
        await db.exec("reset role");
        assert.deepEqual(
          (
            await row(
              "select jsonb_agg(to_jsonb(p) order by id) v from public.published_shifts p where schedule_id=$1",
              [schedule.id],
            )
          ).v,
          before,
        );
      },
    );
    await t.test(
      "multi-workspace URLs remain separate; unauthorized workspace rotation fails",
      async () => {
        await as(2);
        await assert.rejects(manage("rotate", hash("foreign"), other));
        await as(1);
        await manage("rotate", hash("beta"), other);
        const beta = (await feed(hash("beta"))).events;
        assert.equal(beta.length, 1);
        assert.equal(beta[0].organization_id, other);
        assert.equal(beta[0].details.label, "Historical Tokyo shift");
        assert.equal(beta[0].details.starts_at, "2025-01-05T00:00:00+00:00");
        assert.equal((await feed()).events.length, 1);
        assert.equal((await feed(hash("unknown"))).status, "invalid");
      },
    );
    await t.test(
      "publish modifies existing UID once; identical reinsert does not change sequence/timestamp",
      async () => {
        await as(0);
        await command("publish", { schedule_id: schedule.id });
        const changed = (await feed()).events[0];
        assert.equal(changed.shift_id, original);
        assert.equal(changed.sequence, 1);
        assert.equal(changed.details.label, "Unpublished secret");
        await as(0);
        await db.exec("set timezone='Asia/Tokyo'");
        await command("group_staffing", {
          schedule_id: schedule.id,
          shift_group_id: group.id,
          required_count: 2,
        });
        await command("publish", { schedule_id: schedule.id });
        assert.deepEqual((await feed()).events[0], changed);
        await db.exec("set timezone='UTC'");
      },
    );
    await t.test(
      "pending swaps stay private; consent plus approval reconciles old/new assignments",
      async () => {
        await as(0);
        const g2 = await command("group_save", {
          schedule_id: schedule.id,
          employee_id: users[2],
          label: "Day desk",
          starts_at: "2027-01-05T14:00:00Z",
          ends_at: "2027-01-05T20:00:00Z",
          required_count: 1,
        });
        // Remove coworker's shared assignment to avoid overlap after swapping.
        const coworker = (
          await row(
            "select id from public.shifts where shift_group_id=$1 and employee_id=$2",
            [group.id, users[2]],
          )
        ).id;
        await command("group_assign", {
          schedule_id: schedule.id,
          shift_group_id: group.id,
          assignment_id: coworker,
          employee_id: "",
        });
        await command("publish", { schedule_id: schedule.id });
        const second = (
          await row(
            "select id from public.published_shifts where shift_group_id=$1 and employee_id=$2",
            [g2.id, users[2]],
          )
        ).id;
        const request = async (cmd: string, payload: object) =>
          (
            await row("select public.shift_request_command($1,$2,$3) r", [
              org,
              cmd,
              JSON.stringify(payload),
            ])
          ).r;
        await as(1);
        const swap = await request("swap", {
          shift_id: original,
          other_shift_id: second,
        });
        assert.equal(
          (await feed()).events.filter((e: any) => !e.cancelled).length,
          1,
        );
        await as(2);
        await request("accept", { request_id: swap.id });
        assert.equal(
          (await feed()).events.find((e: any) => e.shift_id === original)
            .cancelled,
          false,
        );
        await as(0);
        await request("approve", { request_id: swap.id });
        const events = (await feed()).events;
        assert.equal(
          events.find((e: any) => e.shift_id === original).cancelled,
          true,
        );
        assert.equal(
          events.find((e: any) => e.shift_id === second).cancelled,
          false,
        );
      },
    );
    await t.test(
      "deleted published shifts leave durable cancellation; draft deletion waits for publish",
      async () => {
        await as(0);
        await command("group_delete", {
          schedule_id: schedule.id,
          shift_group_id: group.id,
        });
        // One other live event remains after the approved swap.
        const before = (await feed()).events;
        await as(0);
        await command("publish", { schedule_id: schedule.id });
        const after = (await feed()).events;
        assert.equal(after.length, before.length);
        assert.equal(
          after.find((e: any) => e.shift_id === original).cancelled,
          true,
        );
        await as(0);
        const active = (
          await row(
            "select shift_group_id from public.published_shifts where employee_id=$1 and schedule_id=$2",
            [users[1], schedule.id],
          )
        ).shift_group_id;
        await command("group_delete", {
          schedule_id: schedule.id,
          shift_group_id: active,
        });
        assert.equal(
          (await feed()).events.filter((e: any) => !e.cancelled).length,
          1,
        );
        await as(0);
        await command("publish", { schedule_id: schedule.id });
        assert.equal(
          (await feed()).events.filter((e: any) => !e.cancelled).length,
          0,
        );
      },
    );
    await t.test(
      "rotation, expiry and revocation immediately reject old tokens",
      async () => {
        await as(1);
        await manage("rotate", hash("rotated"));
        assert.equal((await feed()).status, "invalid");
        assert.equal((await feed(hash("rotated"))).status, "ok");
        await db.exec("reset role");
        await db.query(
          "update shiftly_private.calendar_subscriptions set expires_at=now()-interval '1 second' where token_hash=$1",
          [hash("rotated")],
        );
        assert.equal((await feed(hash("rotated"))).status, "invalid");
        await as(1);
        await manage("rotate", hash("rotated"));
        await manage("revoke");
        assert.equal((await feed(hash("rotated"))).status, "invalid");
      },
    );
    await t.test(
      "archive, disconnect, membership loss deny access permanently and preserve other businesses",
      async () => {
        await as(1);
        await manage("rotate", hash("lifecycle"));
        await as(0);
        const result = (
          await row("select public.employee_lifecycle($1,$2,'archive') r", [
            org,
            users[1],
          ])
        ).r;
        assert.equal(result.ok, true);
        assert.equal((await feed(hash("lifecycle"))).status, "invalid");
        assert.equal((await feed(hash("beta"))).status, "ok");
        await as(0);
        await db.query("select public.employee_lifecycle($1,$2,'restore')", [
          org,
          users[1],
        ]);
        await db.exec("reset role");
        await db.query(
          "update public.employees set user_id=$1 where organization_id=$2 and id=$1",
          [users[1], org],
        );
        await db.query(
          "insert into public.memberships values($1,$2,'employee')",
          [org, users[1]],
        );
        assert.equal((await feed(hash("lifecycle"))).status, "invalid");
        await as(1);
        await manage("rotate", hash("disconnect"));
        await db.exec("reset role");
        await db.query(
          "update public.employees set user_id=null where organization_id=$1 and id=$2",
          [org, users[1]],
        );
        assert.equal((await feed(hash("disconnect"))).status, "invalid");
        await db.exec("reset role");
        await db.query(
          "update public.employees set user_id=$2 where organization_id=$1 and id=$2",
          [org, users[1]],
        );
        await as(1);
        await manage("rotate", hash("removed"));
        await db.exec("reset role");
        await db.query(
          "delete from public.memberships where organization_id=$1 and user_id=$2",
          [org, users[1]],
        );
        assert.equal((await feed(hash("removed"))).status, "invalid");
        await db.exec("reset role");
        await db.query(
          "insert into public.memberships values($1,$2,'employee')",
          [org, users[1]],
        );
        assert.equal((await feed(hash("removed"))).status, "invalid");
      },
    );
    await t.test(
      "durable rate limits bound valid and invalid requests",
      async () => {
        await db.exec("reset role");
        await db.query(
          "update shiftly_private.calendar_subscriptions set request_window=date_trunc('minute',now()),request_count=120 where token_hash=$1",
          [hash("beta")],
        );
        assert.equal((await feed(hash("beta"), 7)).status, "limited");
        await db.exec("reset role");
        await db.query(
          "insert into shiftly_private.calendar_request_buckets values(8,date_trunc('minute',now()),600)",
        );
        assert.equal((await feed(hash("invalid"), 8)).status, "limited");
        assert.equal((await feed(hash("beta"), -1)).status, "invalid");
        await db.exec("reset role");
        await db.query(
          "update shiftly_private.calendar_subscriptions set request_window=now()-interval '2 minutes' where token_hash=$1",
          [hash("beta")],
        );
        assert.equal((await feed(hash("beta"), 7)).status, "ok");
      },
    );
  } finally {
    await db.close();
  }
});
