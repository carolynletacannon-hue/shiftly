import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { migrationDatabase } from "./support/migration-database";
import { preferenceDefaults } from "../lib/notifications/preferences";
import { notificationEmail } from "../lib/notifications/email";
import { deliverShiftEmails } from "../lib/shift-requests/email";

test("notification defaults and branded private email", async () => {
  for (const key of [
    "coverage",
    "swap",
    "time_off",
    "schedule_change",
    "approval",
  ] as const)
    assert.equal(preferenceDefaults[key], true);
  for (const key of [
    "schedule_published",
    "reminder_24h",
    "reminder_1h",
  ] as const)
    assert.equal(preferenceDefaults[key], false);
  const email = notificationEmail(
    '<script>alert("x")</script>',
    "https://example.test/workspaces/test/notifications",
  );
  assert.ok(!email.html.includes("<script>"));
  assert.ok(email.html.includes("&lt;script&gt;"));
  assert.ok(
    email.text.includes("https://example.test/workspaces/test/notifications"),
  );
  const flag = process.env.PHASE7_EMAIL_ENABLED;
  delete process.env.PHASE7_EMAIL_ENABLED;
  try {
    await deliverShiftEmails();
  } finally {
    if (flag !== undefined) process.env.PHASE7_EMAIL_ENABLED = flag;
  }
});

test("PostgreSQL notifications: preferences, private inbox, semantic events, snapshots and bounded leases", async (t) => {
  const db = await migrationDatabase();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; alter role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon,service_role;
      grant execute on function auth.uid() to authenticated,anon,service_role;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(await readFile(new URL(file, dir), "utf8"));
    const users = Array.from(
      { length: 4 },
      (_, i) => `f7000000-0000-0000-0000-00000000000${i + 1}`,
    );
    for (const [i, id] of users.entries())
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [id, `notification${i}@example.test`],
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
    await as(0);
    const org = (
      await row(
        "select public.create_workspace('Notification Test','America/Denver') id",
      )
    ).id;
    await as(3);
    const other = (
      await row(
        "select public.create_workspace('Other Workplace','Asia/Tokyo') id",
      )
    ).id;
    await db.exec("reset role");
    await db.query(
      "insert into public.memberships values($1,$2,'employee'),($1,$3,'employee'),($4,$2,'employee')",
      [org, users[1], users[2], other],
    );
    const command = async (name: string, payload: Record<string, unknown>) => {
      const revision = payload.schedule_id
        ? (
            await row("select revision from public.schedules where id=$1", [
              payload.schedule_id,
            ])
          ).revision
        : null;
      return (
        await row("select public.schedule_command($1,$2,$3,$4) r", [
          org,
          name,
          JSON.stringify(payload),
          revision,
        ])
      ).r;
    };
    const transfer = async (name: string, payload: object) =>
      (
        await row("select public.shift_request_command($1,$2,$3) r", [
          org,
          name,
          JSON.stringify(payload),
        ])
      ).r;
    const off = async (name: string, payload: object) =>
      (
        await row("select public.time_off_command($1,$2,$3) r", [
          org,
          name,
          JSON.stringify(payload),
        ])
      ).r;
    const count = async (category?: string) =>
      Number(
        (
          await row(
            "select count(*) n from public.shift_notifications where organization_id=$1 and ($2::text is null or category=$2)",
            [org, category || null],
          )
        ).n,
      );
    await t.test(
      "workspace-specific defaults persist and managers cannot edit another user's preferences",
      async () => {
        await as(1);
        const p = await row(
          "insert into public.notification_preferences(organization_id,user_id) values($1,$2) returning *",
          [org, users[1]],
        );
        for (const [key, value] of Object.entries(preferenceDefaults))
          assert.equal(p[key], value);
        await db.query(
          "update public.notification_preferences set coverage=false where organization_id=$1",
          [org],
        );
        await db.query(
          "insert into public.notification_preferences(organization_id,user_id) values($1,$2)",
          [other, users[1]],
        );
        assert.equal(
          (
            await row(
              "select coverage from public.notification_preferences where organization_id=$1",
              [other],
            )
          ).coverage,
          true,
        );
        await as(0);
        assert.equal(
          (
            await db.query(
              "update public.notification_preferences set coverage=true where user_id=$1 returning *",
              [users[1]],
            )
          ).rows.length,
          0,
        );
        await assert.rejects(
          db.query(
            "insert into public.notification_preferences(organization_id,user_id) values($1,$2)",
            [org, users[2]],
          ),
        );
      },
    );
    await as(0);
    const week = await command("create", { week_start: "2030-01-06" });
    const shift = await command("group_save", {
      schedule_id: week.id,
      employee_id: users[1],
      label: "Overnight",
      starts_at: "2030-01-07T05:00:00Z",
      ends_at: "2030-01-07T13:00:00Z",
      required_count: 1,
    });
    await t.test(
      "draft, first publication and unchanged republication are quiet by default",
      async () => {
        assert.equal(await count(), 0);
        await command("publish", { schedule_id: week.id });
        assert.equal(await count(), 0);
        await assert.rejects(command("publish", { schedule_id: week.id }));
        assert.equal(await count(), 0);
      },
    );
    await t.test(
      "published time changes notify only the affected employee with old/new local overnight times",
      async () => {
        await command("group_save", {
          schedule_id: week.id,
          shift_group_id: shift.id,
          label: "Overnight",
          starts_at: "2030-01-07T06:00:00Z",
          ends_at: "2030-01-07T14:00:00Z",
          required_count: 1,
        });
        assert.equal(await count(), 0);
        await command("publish", { schedule_id: week.id });
        await as(1);
        assert.equal(await count("schedule_change"), 1);
        await as(1);
        const n = await row(
          "select * from public.shift_notifications where category='schedule_change'",
        );
        assert.equal(n.user_id, users[1]);
        assert.match(n.message, /Previous shifts \(America\/Denver\)/);
        assert.match(n.message, /Current shifts/);
        assert.equal(n.href, `/workspaces/${org}/my-schedule?week=2030-01-06`);
        await as(0);
      },
    );
    await t.test(
      "a new publication revision with unchanged assignments stays quiet",
      async () => {
        await as(1);
        const previous = await count("schedule_change");
        await as(0);
        await command("group_staffing", {
          schedule_id: week.id,
          shift_group_id: shift.id,
          required_count: 1,
          allow_overstaffing: true,
        });
        await command("publish", { schedule_id: week.id });
        await as(1);
        assert.equal(await count("schedule_change"), previous);
        await as(0);
      },
    );
    let request: any;
    await t.test(
      "coverage offers await approval, then become official without duplicate schedule alerts",
      async () => {
        await as(1);
        const assignment = (
          await row(
            "select id from public.published_shifts where schedule_id=$1 and employee_id=$2",
            [week.id, users[1]],
          )
        ).id;
        request = await transfer("coverage", { shift_id: assignment });
        await as(2);
        request = await transfer("accept", { request_id: request.id });
        assert.equal(request.status, "pending");
        await as(1);
        const n = await row(
          "select * from public.shift_notifications where category='coverage' order by created_at desc limit 1",
        );
        assert.match(n.message, /approval is still required/);
        assert.equal(n.request_id, request.id);
        await as(0);
        assert.equal(await count("approval"), 1);
        request = await transfer("approve", { request_id: request.id });
        assert.equal(request.status, "completed");
        await as(1);
        assert.equal(await count("schedule_change"), 1);
        await db.exec("reset role");
        assert.equal(
          Number(
            (
              await row(
                "select count(*) n from public.shift_notifications where event_key=$1",
                [`transfer:${request.id}:completed`],
              )
            ).n,
          ),
          2,
        );
        await as(0);
        await assert.rejects(transfer("approve", { request_id: request.id }));
      },
    );
    await t.test(
      "time-off review, denial, approval and manager revocation stay private",
      async () => {
        await as(1);
        let r = await off("submit", {
          employee_id: users[1],
          start_date: "2030-02-02",
          end_date: "2030-02-02",
          full_day: true,
          notes: "Private notes must never enter notifications",
        });
        await as(0);
        await off("deny", { id: r.id });
        await as(1);
        assert.equal(await count("time_off"), 1);
        r = await off("submit", {
          employee_id: users[1],
          start_date: "2030-02-03",
          end_date: "2030-02-03",
          full_day: true,
        });
        await as(0);
        await off("approve", { id: r.id });
        await as(1);
        await assert.rejects(off("revoke", { id: r.id }));
        await as(0);
        await off("revoke", { id: r.id });
        await as(1);
        assert.equal(await count("time_off"), 3);
        assert.equal(
          (
            await db.query(
              "select * from public.shift_notifications where message like '%Private notes%' ",
            )
          ).rows.length,
          0,
        );
      },
    );
    await t.test(
      "read/unread, counts, other-user isolation and fraud prevention",
      async () => {
        await as(1);
        const n = await row(
          "select * from public.shift_notifications where read_at is null limit 1",
        );
        assert.ok(n);
        await db.query(
          "update public.shift_notifications set read_at=now() where id=$1",
          [n.id],
        );
        assert.ok(
          (
            await row(
              "select read_at from public.shift_notifications where id=$1",
              [n.id],
            )
          ).read_at,
        );
        await assert.rejects(
          db.query(
            "update public.shift_notifications set message='Fraud' where id=$1",
            [n.id],
          ),
        );
        await assert.rejects(
          db.query(
            "insert into public.shift_notifications(organization_id,user_id,message) values($1,$2,'Fraud')",
            [org, users[1]],
          ),
        );
        await as(2);
        assert.equal(
          (
            await db.query(
              "select * from public.shift_notifications where id=$1",
              [n.id],
            )
          ).rows.length,
          0,
        );
        assert.equal(
          (
            await db.query(
              "update public.shift_notifications set read_at=now() where id=$1 returning id",
              [n.id],
            )
          ).rows.length,
          0,
        );
        await as(3);
        assert.equal(await count(), 0);
        await assert.rejects(db.query("select public.claim_shift_emails()"));
        await assert.rejects(
          db.query(
            "select shiftly_private.notify($1,$2,'coverage','fraud','Fraud','/')",
            [org, users[3]],
          ),
        );
      },
    );
    await t.test(
      "swap proposal, decline, manager rejection and approval use dedicated events",
      async () => {
        await as(0);
        await command("group_save", {
          schedule_id: week.id,
          employee_id: users[1],
          label: "Second shift",
          starts_at: "2030-01-08T16:00:00Z",
          ends_at: "2030-01-08T20:00:00Z",
          required_count: 1,
        });
        await command("publish", { schedule_id: week.id });
        const first = (
          await row(
            "select id from public.published_shifts where schedule_id=$1 and employee_id=$2",
            [week.id, users[2]],
          )
        ).id;
        const second = (
          await row(
            "select id from public.published_shifts where schedule_id=$1 and employee_id=$2",
            [week.id, users[1]],
          )
        ).id;
        await as(2);
        let r = await transfer("swap", {
          shift_id: first,
          other_shift_id: second,
        });
        await as(1);
        assert.match(
          (
            await row(
              "select message from public.shift_notifications where event_key=$1",
              [`transfer:${r.id}:open`],
            )
          ).message,
          /requested a shift swap/,
        );
        await transfer("decline", { request_id: r.id });
        await as(2);
        assert.match(
          (
            await row(
              "select message from public.shift_notifications where event_key=$1",
              [`transfer:${r.id}:declined`],
            )
          ).message,
          /declined/,
        );
        r = await transfer("swap", { shift_id: first, other_shift_id: second });
        await as(1);
        await transfer("accept", { request_id: r.id });
        await as(0);
        await transfer("deny", { request_id: r.id });
        await as(1);
        assert.match(
          (
            await row(
              "select message from public.shift_notifications where event_key=$1",
              [`transfer:${r.id}:denied`],
            )
          ).message,
          /rejected/,
        );
        await as(2);
        r = await transfer("swap", { shift_id: first, other_shift_id: second });
        await as(1);
        await transfer("accept", { request_id: r.id });
        const previous = await count("schedule_change");
        await as(0);
        await transfer("approve", { request_id: r.id });
        await as(1);
        assert.equal(await count("schedule_change"), previous);
        assert.match(
          (
            await row(
              "select message from public.shift_notifications where event_key=$1",
              [`transfer:${r.id}:completed`],
            )
          ).message,
          /approved and official/,
        );
      },
    );
    await t.test(
      "automatic coverage reports final state only; pending volunteers can withdraw",
      async () => {
        await as(0);
        let policy = await row(
          "select revision from public.shift_coverage_policies where organization_id=$1",
          [org],
        );
        await transfer("policy", {
          revision: policy.revision,
          require_manager: false,
        });
        const assignment = (
          await row(
            "select id from public.published_shifts where schedule_id=$1 and employee_id=$2",
            [week.id, users[1]],
          )
        ).id;
        await as(1);
        let r = await transfer("coverage", { shift_id: assignment });
        await as(2);
        r = await transfer("accept", { request_id: r.id });
        assert.equal(r.status, "completed");
        await as(1);
        assert.equal(
          (
            await db.query(
              "select * from public.shift_notifications where event_key=$1",
              [`transfer:${r.id}:pending`],
            )
          ).rows.length,
          0,
        );
        await as(0);
        policy = await row(
          "select revision from public.shift_coverage_policies where organization_id=$1",
          [org],
        );
        await transfer("policy", {
          revision: policy.revision,
          require_manager: true,
        });
        await as(2);
        r = await transfer("coverage", { shift_id: assignment });
        await as(1);
        await transfer("accept", { request_id: r.id });
        await as(0);
        await assert.rejects(transfer("withdraw", { request_id: r.id }));
        await as(1);
        r = await transfer("withdraw", { request_id: r.id });
        assert.equal(r.status, "cancelled");
        await as(2);
        assert.match(
          (
            await row(
              "select message from public.shift_notifications where event_key=$1",
              [`transfer:${r.id}:cancelled`],
            )
          ).message,
          /cancelled/,
        );
      },
    );
    await t.test(
      "weekly publication is explicitly opt-in and archived recipients are suppressed",
      async () => {
        await as(1);
        await db.query(
          "update public.notification_preferences set schedule_published=true where organization_id=$1",
          [org],
        );
        await as(0);
        const optionalWeek = await command("create", {
          week_start: "2030-03-03",
        });
        await command("group_save", {
          schedule_id: optionalWeek.id,
          employee_id: users[1],
          label: "Optional email",
          starts_at: "2030-03-04T16:00:00Z",
          ends_at: "2030-03-04T20:00:00Z",
          required_count: 1,
        });
        await command("publish", { schedule_id: optionalWeek.id });
        await as(1);
        assert.equal(await count("schedule_published"), 1);
        await as(2);
        assert.equal(await count("schedule_published"), 0);
        await db.exec("reset role");
        await db.query(
          "update public.employees set archived_at=now() where organization_id=$1 and user_id=$2",
          [org, users[2]],
        );
        await db.query(
          "select shiftly_private.notify($1,$2,'coverage','archived-test','Should not send','/')",
          [org, users[2]],
        );
        assert.equal(
          (
            await db.query(
              "select * from public.shift_notifications where event_key='archived-test'",
            )
          ).rows.length,
          0,
        );
        const claimed = (
          await db.query<any>("select * from public.claim_shift_emails()")
        ).rows;
        assert.ok(claimed.every((q) => q.user_id !== users[2]));
        await db.query(
          "update public.employees set archived_at=null where organization_id=$1 and user_id=$2",
          [org, users[2]],
        );
        await db.query(
          "update public.shift_email_deliveries set attempts=0,claimed_until=null",
        );
      },
    );
    await t.test(
      "scoped claims affect only the manager's workspace and deny browser roles",
      async () => {
        await as(0);
        await assert.rejects(
          db.query(
            "select * from public.claim_workspace_notification_emails($1)",
            [org],
          ),
        );
        await db.exec("reset role");
        // Existing fixtures contain eligible work in org. An empty other workspace must not claim it.
        const before = (
          await db.query(
            "select id,attempts,claim_token from public.shift_email_deliveries order by id",
          )
        ).rows;
        await db.exec("set role service_role");
        assert.equal(
          (
            await db.query(
              "select * from public.claim_workspace_notification_emails($1)",
              [other],
            )
          ).rows.length,
          0,
        );
        await db.exec("reset role");
        assert.deepEqual(
          (
            await db.query(
              "select id,attempts,claim_token from public.shift_email_deliveries order by id",
            )
          ).rows,
          before,
        );
        await db.exec("set role service_role");
        const claimed = (
          await db.query<any>(
            "select * from public.claim_workspace_notification_emails($1)",
            [org],
          )
        ).rows;
        assert.ok(claimed.length > 0);
        assert.ok(claimed.every((q) => q.organization_id === org));
        const next = (
          await db.query<any>(
            "select * from public.claim_workspace_notification_emails($1)",
            [org],
          )
        ).rows;
        assert.ok(
          next.every((q) => !claimed.some((previous) => previous.id === q.id)),
        );
        await db.exec("reset role");
        await db.query(
          "update public.shift_email_deliveries set attempts=0,claimed_until=null",
        );
      },
    );
    await t.test(
      "queue respects opt-outs, resolved approvals, disconnects, bounded retries and claim fencing",
      async () => {
        await db.exec("reset role");
        const claimed = (
          await db.query<any>("select * from public.claim_shift_emails()")
        ).rows;
        assert.ok(claimed.length > 0);
        assert.ok(claimed.length <= 10);
        // Isolate the first bounded batch before testing lease recovery.
        await db.query(
          "update public.shift_email_deliveries set attempts=5 where not(id=any($1::uuid[]))",
          [claimed.map((q) => q.id)],
        );
        await db.exec("set role service_role");
        assert.equal(
          (await db.query("select * from public.claim_shift_emails()")).rows
            .length,
          0,
        );
        await db.exec("reset role");
        for (const q of claimed) {
          const n = await row(
            "select category from public.shift_notifications where id=$1",
            [q.id],
          );
          assert.notEqual(n.category, "approval");
          if (q.user_id === users[1]) assert.notEqual(n.category, "coverage");
          assert.equal(
            (
              await row("select public.notification_email_eligible($1,$2) ok", [
                q.id,
                q.claim_token,
              ])
            ).ok,
            true,
          );
          await db.query(
            "update public.shift_email_deliveries set claimed_until=now()-interval '1 minute' where id=$1",
            [q.id],
          );
        }
        const retry = (
          await db.query<any>("select * from public.claim_shift_emails()")
        ).rows;
        assert.equal(retry.length, claimed.length);
        assert.notEqual(retry[0].claim_token, claimed[0].claim_token);
        assert.equal(
          (
            await row("select public.notification_email_eligible($1,$2) ok", [
              claimed[0].id,
              claimed[0].claim_token,
            ])
          ).ok,
          false,
        );
        await db.query(
          "update public.shift_email_deliveries set attempts=5,claimed_until=now()-interval '1 minute'",
        );
        assert.equal(
          (await db.query("select * from public.claim_shift_emails()")).rows
            .length,
          0,
        );
        await db.query(
          "update public.shift_email_deliveries set attempts=0,claimed_until=null",
        );
        await db.query(
          "delete from public.memberships where organization_id=$1 and user_id=$2",
          [org, users[2]],
        );
        assert.ok(
          (
            await db.query<any>("select * from public.claim_shift_emails()")
          ).rows.every((q) => q.user_id !== users[2]),
        );
      },
    );
  } finally {
    await db.close();
  }
});

test("email failures remain retryable; batches group only the same workplace recipient", async () => {
  const { deliverNotificationBatch } = await import(
    "../lib/notifications/delivery"
  );
  const jobs = [
    {
      id: "a",
      organization_id: "one",
      user_id: "u",
      claim_token: "token-a",
      message: "First update",
    },
    {
      id: "b",
      organization_id: "one",
      user_id: "u",
      claim_token: "token-b",
      message: "Second update",
    },
    {
      id: "c",
      organization_id: "two",
      user_id: "u",
      claim_token: "token-c",
      message: "Other workplace",
    },
    {
      id: "d",
      organization_id: "one",
      user_id: "archived",
      claim_token: "token-d",
      message: "Must not send",
    },
  ];
  const finished: string[] = [];
  const sent: string[] = [];
  const worker = {
    claim: async () => jobs,
    prepare: async (item: (typeof jobs)[number]) =>
      item.user_id === "archived"
        ? null
        : {
            ...item,
            email: "fixture@example.test",
            url: `https://example.test/workspaces/${item.organization_id}/notifications`,
          },
    finish: async (item: (typeof jobs)[number]) => {
      finished.push(item.id);
    },
  };
  await deliverNotificationBatch(worker, async () => ({ status: "failed" }));
  assert.deepEqual(finished, []);
  await deliverNotificationBatch(worker, async () => {
    throw Error("Private SMTP error must not escape");
  });
  assert.deepEqual(finished, []);
  await deliverNotificationBatch(worker, async (message, key) => {
    sent.push(key);
    assert.ok(!message.text.includes("Must not send"));
    return { status: "accepted" };
  });
  assert.deepEqual(sent, ["a:b", "c"]);
  assert.deepEqual(finished, ["a", "b", "c"]);
});
