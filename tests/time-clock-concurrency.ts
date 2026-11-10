import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { digest, hashPin } from "../lib/time-clock/security";
test("native PostgreSQL: concurrent punches, lost responses, correction races and revocation", async () => {
  const connectionString = process.env.SHIFTLY_TEST_DATABASE_URL;
  assert.ok(connectionString, "Provide a disposable local PostgreSQL cluster");
  const url = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const admin = new Client({ connectionString });
  await admin.connect();
  const database = `timeclock_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database "${database}"`);
  url.pathname = `/${database}`;
  const clients: Client[] = [];
  const connect = async () => {
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    clients.push(c);
    return c;
  };
  try {
    const a = await connect(),
      b = await connect();
    await a.query(`do $$begin create role anon;exception when duplicate_object then null;end$$;do $$begin create role authenticated;exception when duplicate_object then null;end$$;do $$begin create role service_role;exception when duplicate_object then null;end$$;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const f of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await a.query(await readFile(new URL(f, dir), "utf8"));
    const user = randomUUID();
    await a.query(
      "insert into auth.users(id,email,email_confirmed_at)values($1,'concurrent-time@example.test',now())",
      [user],
    );
    const asManager = async (c: Client) => {
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claim.sub',$1,false)", [
        user,
      ]);
      await c.query("set role authenticated");
    };
    await asManager(a);
    const org = (
      await a.query(
        "select public.create_workspace('Synthetic Concurrent Clock','America/Denver') id",
      )
    ).rows[0].id;
    const manage = async (c: Client, command: string, payload: object = {}) =>
      (
        await c.query("select public.time_clock_manage($1,$2,$3) r", [
          org,
          command,
          JSON.stringify(payload),
        ])
      ).rows[0].r;
    await manage(a, "settings", { enabled: true });
    const enrolled = await manage(a, "enroll", {
      name: "Concurrency Tablet",
      token_hash: digest("device"),
    });
    const employee = (
      await a.query(
        "select id from public.employees where organization_id=$1",
        [org],
      )
    ).rows[0].id;
    const pin = hashPin("1234");
    await manage(a, "pin", {
      employee_id: employee,
      lookup_hash: digest("lookup"),
      pin_hash: pin,
    });
    const service = async (c: Client) =>
      c.query("reset role;set role service_role");
    const kiosk = async (c: Client, command: string, payload: object = {}) =>
      (
        await c.query("select public.time_clock_kiosk($1,$2,$3) r", [
          digest("device"),
          command,
          JSON.stringify(payload),
        ])
      ).rows[0].r;
    const authorize = async () => {
      await service(a);
      assert.ok(
        !(
          await kiosk(a, "authorize", {
            employee_id: employee,
            verified_hash: pin,
            challenge_hash: digest("challenge"),
          })
        ).error,
      );
    };
    const punch = (c: Client, action: string, id: string) =>
      kiosk(c, "punch", {
        action,
        request_id: id,
        challenge_hash: digest("challenge"),
      });
    await authorize();
    await service(b);
    await a.query("begin");
    const firstId = randomUUID();
    const first = await punch(a, "in", firstId);
    let resolved = false;
    const queued = punch(b, "in", randomUUID()).then((r) => {
      resolved = true;
      return r;
    });
    // Observe a real database lock wait, rather than assuming scheduling from a sleep.
    const observer = await connect();
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const rows = (
        await observer.query(
          "select wait_event_type from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()",
          [database],
        )
      ).rows;
      if (rows.some((r) => r.wait_event_type === "Lock")) {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(waiting, "second session waits on the organization lock");
    assert.equal(resolved, false);
    await a.query("commit");
    assert.ok((await queued).error);
    assert.equal(first.ok, true);
    assert.deepEqual(
      await punch(b, "in", firstId),
      first,
      "lost response retry retrieves the committed receipt",
    );
    await authorize();
    await a.query("begin");
    const outId = randomUUID();
    const out = await punch(a, "out", outId);
    const retry = punch(b, "out", outId);
    await a.query("commit");
    assert.deepEqual(await retry, out);
    await asManager(a);
    await asManager(b);
    const card = (
      await a.query(
        "select * from public.time_sessions where organization_id=$1",
        [org],
      )
    ).rows[0];
    const correction = {
      session_id: card.id,
      revision: card.revision,
      clock_in: "2026-11-01T06:00:00Z",
      clock_out: "2026-11-01T10:00:00Z",
      breaks: [],
      reason: "Concurrent correction review",
    };
    await a.query("begin");
    await manage(a, "correct", correction);
    const stale = manage(b, "correct", correction).then(
      () => false,
      () => true,
    );
    await a.query("commit");
    assert.ok(await stale, "one correction revision wins");
    await a.query("begin");
    await manage(a, "revoke", { kiosk_id: enrolled.id });
    await service(b);
    const revoked = kiosk(b, "info");
    await a.query("commit");
    assert.match((await revoked).error, /authorization/);
    await a.query("reset role");
    assert.equal(
      (await a.query("select count(*)::int n from public.time_punch_events"))
        .rows[0].n,
      2,
    );
    assert.equal(
      (
        await a.query(
          "select count(*)::int n from public.time_audit where action='correct'",
        )
      ).rows[0].n,
      1,
    );

    // Distinct employees can punch simultaneously on independent kiosks. The
    // organization lock serializes transitions without imposing shift order.
    await a.query("reset role");
    const secondUser = randomUUID();
    await a.query(
      "insert into auth.users(id,email,email_confirmed_at)values($1,'handoff@example.test',now())",
      [secondUser],
    );
    await a.query("insert into public.memberships values($1,$2,'employee')", [
      org,
      secondUser,
    ]);
    const secondEmployee = (
      await a.query(
        "select id from public.employees where organization_id=$1 and user_id=$2",
        [org, secondUser],
      )
    ).rows[0].id;
    await asManager(a);
    await asManager(b);
    const deviceA = digest("handoff-a"),
      deviceB = digest("handoff-b");
    await manage(a, "enroll", { name: "Handoff A", token_hash: deviceA });
    await manage(b, "enroll", { name: "Handoff B", token_hash: deviceB });
    await manage(b, "pin", {
      employee_id: secondEmployee,
      lookup_hash: digest("second-lookup"),
      pin_hash: pin,
    });
    const operate = async (
      c: Client,
      credential: string,
      command: string,
      payload: object = {},
    ) =>
      (
        await c.query("select public.time_clock_kiosk($1,$2,$3) r", [
          credential,
          command,
          JSON.stringify(payload),
        ])
      ).rows[0].r;
    await service(a);
    await service(b);
    const authA = () =>
      operate(a, deviceA, "authorize", {
        employee_id: employee,
        verified_hash: pin,
        challenge_hash: digest("handoff-challenge-a"),
      });
    const authB = () =>
      operate(b, deviceB, "authorize", {
        employee_id: secondEmployee,
        verified_hash: pin,
        challenge_hash: digest("handoff-challenge-b"),
      });
    await Promise.all([authA(), authB()]);
    const punchA = (action: string) =>
      operate(a, deviceA, "punch", {
        action,
        request_id: randomUUID(),
        challenge_hash: digest("handoff-challenge-a"),
      });
    const punchB = (action: string) =>
      operate(b, deviceB, "punch", {
        action,
        request_id: randomUUID(),
        challenge_hash: digest("handoff-challenge-b"),
      });
    const starts = await Promise.all([punchA("in"), punchB("in")]);
    assert.ok(starts.every((r) => r.ok));
    await authA();
    assert.ok((await punchA("out")).ok);
    await a.query("reset role");
    assert.equal(
      (
        await a.query(
          "select count(*)::int n from public.time_sessions where organization_id=$1 and employee_id=$2 and clock_out is null",
          [org, secondEmployee],
        )
      ).rows[0].n,
      1,
    );
    await authB();
    assert.ok((await punchB("out")).ok);
    // Fetch by kiosk ids rather than clock precision/ordering assumptions.
    const complete = (
      await a.query(
        "select s.* from public.time_sessions s join public.time_kiosks k on k.id=s.kiosk_id where k.organization_id=$1 and k.name in ('Handoff A','Handoff B') order by s.id",
        [org],
      )
    ).rows;
    assert.equal(complete.length, 2);
    assert.ok(
      complete.every((c) => c.approved_at && c.approval_source === "automatic"),
    );
    // Simulate previously pending routine records, then correct one concurrently
    // with a confirmed bulk request. No stale approval may win the org lock.
    await a.query(
      "update public.time_sessions set approved_at=null,approved_by=null,revision=revision+1 where id=any($1::uuid[])",
      [complete.map((c) => c.id)],
    );
    await asManager(a);
    await asManager(b);
    const dates = {
      from: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10),
      to: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
    };
    const preview = await manage(a, "bulk_preview", dates);
    assert.equal(preview.count, 2);
    const fresh = (
      await a.query(
        "select *,clock_in::text as punch_in,clock_out::text as punch_out from public.time_sessions where id=$1",
        [complete[0].id],
      )
    ).rows[0];
    await a.query("begin");
    await manage(a, "correct", {
      session_id: fresh.id,
      revision: fresh.revision,
      clock_in: fresh.punch_in,
      clock_out: fresh.punch_out,
      breaks: [],
      reason: "Concurrent handoff correction",
    });
    const bulk = manage(b, "bulk_approve", {
      ...dates,
      token: preview.token,
      confirmed: true,
    }).then(
      () => false,
      (e) => /changed/.test(e.message),
    );
    await a.query("commit");
    assert.equal(await bulk, true);
    const reviewed = await manage(a, "bulk_preview", dates);
    assert.equal(reviewed.count, 1);
    assert.equal(
      (
        await manage(a, "bulk_approve", {
          ...dates,
          token: reviewed.token,
          confirmed: true,
        })
      ).approved,
      1,
    );
    await assert.rejects(
      () =>
        manage(b, "bulk_approve", {
          ...dates,
          token: reviewed.token,
          confirmed: true,
        }),
      /changed/,
    );
  } finally {
    for (const c of clients) {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
    await admin.query(`drop database "${database}"`);
    await admin.end();
  }
});
