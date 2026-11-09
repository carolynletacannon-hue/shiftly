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
    const pin = hashPin("123456");
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
  } finally {
    for (const c of clients) {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
    await admin.query(`drop database "${database}"`);
    await admin.end();
  }
});
