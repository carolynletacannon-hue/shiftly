import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { migrationDatabase } from "./support/migration-database";
import { digest, hashPin } from "../lib/time-clock/security";
test("time clock database: roles, enrollment, PIN lockout, punches, idempotency, audit, approvals and isolation", async () => {
  const db = await migrationDatabase();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    let persistentMigration = "";
    for (const file of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      if (file.includes("persistent_kiosk"))
        persistentMigration = await readFile(new URL(file, dir), "utf8");
      else await db.exec(await readFile(new URL(file, dir), "utf8"));
    const row = async (sql: string, args: unknown[] = []) =>
      (await db.query<any>(sql, args)).rows[0];
    const users = Array.from({ length: 4 }, () => randomUUID());
    for (const [i, u] of users.entries())
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())",
        [u, `time${i}@example.test`],
      );
    const as = async (i: number) => {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        users[i],
      ]);
      await db.exec("set role authenticated");
    };
    const service = async () => {
      await db.exec("reset role;set role service_role");
    };
    const manage = async (
      command: string,
      payload: object = {},
      workspace = org,
    ) =>
      (
        await row("select public.time_clock_manage($1,$2,$3) r", [
          workspace,
          command,
          JSON.stringify(payload),
        ])
      ).r;
    const kiosk = async (
      command: string,
      payload: object = {},
      credential = digest("device"),
    ) =>
      (
        await row("select public.time_clock_kiosk($1,$2,$3) r", [
          credential,
          command,
          JSON.stringify(payload),
        ])
      ).r;
    await as(0);
    const org = (
      await row(
        "select public.create_workspace('Synthetic Time Alpha','America/Denver') id",
      )
    ).id;
    await as(3);
    const other = (
      await row(
        "select public.create_workspace('Synthetic Time Beta','America/Denver') id",
      )
    ).id;
    await db.exec("reset role");
    await db.query(
      "insert into public.memberships values($1,$2,'employee'),($1,$3,'manager')",
      [org, users[1], users[2]],
    );
    const employee = (
      await row(
        "select id from public.employees where organization_id=$1 and user_id=$2",
        [org, users[1]],
      )
    ).id;
    await as(1);
    await assert.rejects(manage("settings", { enabled: true }), /Manager/);
    await assert.rejects(
      db.query("select public.time_clock_kiosk($1,'info','{}')", [
        digest("device"),
      ]),
      /permission denied/,
    );
    await as(0);
    await assert.rejects(
      manage("enroll", { name: "Tablet", token_hash: digest("device") }),
      /disabled/,
    );
    await manage("settings", { enabled: true, require_breaks: true });
    const k = await manage("enroll", {
      name: "Synthetic Tablet",
      token_hash: digest("device"),
    });
    assert.ok(k.id);
    const revokedLegacy = await manage("enroll", {
      name: "Revoked legacy tablet",
      token_hash: digest("legacy-revoked"),
    });
    await manage("revoke", { kiosk_id: revokedLegacy.id });
    await db.exec("reset role");
    await db.query(
      "update public.time_kiosks set expires_at=now()-interval '3 days' where id=$1",
      [k.id],
    );
    assert.ok(persistentMigration);
    await db.exec(persistentMigration);
    assert.equal(
      (
        await row("select expires_at from public.time_kiosks where id=$1", [
          k.id,
        ])
      ).expires_at,
      null,
    );
    await service();
    assert.ok((await kiosk("info", {}, digest("legacy-revoked"))).error);
    await as(0);
    const pinHash = hashPin("1234");
    await manage("pin", {
      employee_id: employee,
      lookup_hash: digest("lookup"),
      pin_hash: pinHash,
    });
    await assert.rejects(
      db.query("select * from shiftly_private.employee_pins"),
      /permission denied/,
    );
    await service();
    assert.match(
      (await kiosk("info", {}, digest("wrong"))).error,
      /authorization/,
    );
    assert.equal((await kiosk("info")).name, "Synthetic Time Alpha");
    // A browser restart supplies only its durable cookie; no account is involved.
    for (const age of ["13 hours", "7 days", "90 days"]) {
      await db.exec("reset role");
      await db.query(
        "update public.time_kiosks set created_at=now()-$1::interval,expires_at=now()-interval '1 hour',last_activity=now()-$1::interval where id=$2",
        [age, k.id],
      );
      await service();
      assert.equal((await kiosk("info")).name, "Synthetic Time Alpha", age);
    }

    for (let i = 0; i < 5; i++)
      assert.equal(
        (await kiosk("lookup", { lookup_hash: digest("wrong") })).hash,
        "invalid",
      );
    assert.match(
      (await kiosk("lookup", { lookup_hash: digest("lookup") })).error,
      /PIN unavailable/,
    );
    await db.exec("reset role");
    await db.query(
      "update shiftly_private.kiosk_credentials set locked_until=now()-interval '1 second' where kiosk_id=$1",
      [k.id],
    );
    await service();
    assert.equal(
      (await kiosk("lookup", { lookup_hash: digest("lookup") })).employee_id,
      employee,
    );
    const authorize = async () => {
      await service();
      const data = await kiosk("authorize", {
        employee_id: employee,
        verified_hash: pinHash,
        challenge_hash: digest("challenge"),
      });
      assert.ok(!data.error, JSON.stringify(data));
      return data;
    };
    assert.equal((await authorize()).status, "out");
    const punch = async (action: string, request_id = randomUUID()) =>
      kiosk("punch", {
        action,
        request_id,
        challenge_hash: digest("challenge"),
      });
    await db.exec("reset role");
    await db.query(
      "update shiftly_private.kiosk_credentials set challenge_expires=now()-interval '1 second' where kiosk_id=$1",
      [k.id],
    );
    await service();
    assert.match((await punch("in")).error, /PIN again/);
    await authorize();
    const request = randomUUID();
    const receipt = await punch("in", request);
    assert.equal(receipt.ok, true);
    assert.deepEqual(await punch("in", request), receipt);
    assert.match((await punch("out", request)).error, /mismatch/);
    assert.equal((await authorize()).status, "working");
    assert.ok((await punch("in")).error);
    assert.equal((await punch("break_start")).ok, true);
    assert.equal((await authorize()).status, "break");
    assert.ok((await punch("out")).error);
    assert.equal((await punch("break_end")).ok, true);
    await authorize();
    assert.equal((await punch("out")).ok, true);
    await authorize();
    assert.ok((await punch("out")).error);
    await as(1);
    const card = await row(
      "select * from public.time_sessions where organization_id=$1",
      [org],
    );
    assert.ok(card.clock_out);
    assert.equal(
      (await row("select count(*)::int n from public.time_punch_events")).n,
      4,
    );
    await assert.rejects(
      db.query("update public.time_sessions set clock_out=null"),
      /permission denied/,
    );
    await assert.rejects(manage("correct", { session_id: card.id }), /Manager/);
    const req = await manage("request", {
      session_id: card.id,
      reason: "Synthetic correction requested",
    });
    Object.assign(
      card,
      await row("select * from public.time_sessions where id=$1", [card.id]),
    );
    await as(2);
    await assert.rejects(
      manage("approve", { session_id: card.id, revision: card.revision }),
      /Resolve/,
    );
    await assert.rejects(
      manage("review", {
        request_id: req.id,
        decision: "approved",
        reason: "Synthetic approval response",
      }),
      /Apply/,
    );
    const corrected = {
      session_id: card.id,
      revision: card.revision,
      clock_in: "2026-11-01T05:00:00Z",
      clock_out: "2026-11-01T11:00:00Z",
      breaks: [
        { starts_at: "2026-11-01T07:30:00Z", ends_at: "2026-11-01T08:00:00Z" },
      ],
      reason: "Synthetic correction after review",
      request_id: req.id,
    };
    await manage("correct", corrected);
    await assert.rejects(manage("correct", corrected), /changed/);
    await manage("review", {
      request_id: req.id,
      decision: "approved",
      reason: "Reviewed recorded correction",
    });
    await manage("approve", {
      session_id: card.id,
      revision: card.revision + 1,
    });
    assert.equal(
      (
        await row(
          "select count(*)::int n from public.time_audit where session_id=$1 and action in ('correct','request_review','approve')",
          [card.id],
        )
      ).n,
      3,
    );
    await as(1);
    assert.equal(
      (
        await row(
          "select count(*)::int n from public.time_audit where session_id=$1 and action in ('correct','request_review','approve')",
          [card.id],
        )
      ).n,
      3,
    );
    assert.equal(
      (
        await row(
          "select count(*)::int n from public.time_correction_requests where status='approved'",
        )
      ).n,
      1,
    );
    await as(3);
    assert.equal(
      (await row("select count(*)::int n from public.time_sessions")).n,
      0,
    );
    await manage("settings", { enabled: true }, other);
    await assert.rejects(
      manage("revoke", { kiosk_id: k.id }, other),
      /Kiosk unavailable/,
    );
    await assert.rejects(
      manage(
        "pin",
        {
          employee_id: employee,
          lookup_hash: digest("cross"),
          pin_hash: pinHash,
        },
        other,
      ),
      /Employee unavailable/,
    );
    await as(0);
    await assert.rejects(
      manage("correct", {
        employee_id: employee,
        clock_in: corrected.clock_in,
        clock_out: corrected.clock_out,
        breaks: [],
        reason: "Synthetic overlapping session",
      }),
      /overlap/,
    );
    await assert.rejects(
      manage("correct", {
        session_id: card.id,
        revision: card.revision + 2,
        clock_in: corrected.clock_in,
        clock_out: corrected.clock_out,
        breaks: [
          {
            starts_at: "2026-11-01T04:00:00Z",
            ends_at: "2026-11-01T05:30:00Z",
          },
        ],
        reason: "Synthetic invalid break",
      }),
      /inside/,
    );
    await service();
    await authorize();
    await kiosk("rotate", { token_hash: digest("rotated") });
    // Lost renewal response: the browser can keep using and retrying the old secret.
    assert.ok(!(await kiosk("info")).error);
    await kiosk("rotate", { token_hash: digest("rotated") });
    assert.ok(!(await kiosk("info", {}, digest("rotated"))).error);
    // Renewal preserves an employee's independently short-lived challenge.
    await db.exec("reset role");
    const retainedChallenge = await row(
      "select challenge_hash,challenge_expires>clock_timestamp() valid from shiftly_private.kiosk_credentials where kiosk_id=$1",
      [k.id],
    );
    assert.equal(retainedChallenge.challenge_hash, digest("challenge"));
    assert.equal(retainedChallenge.valid, true);
    await service();
    // Once acknowledged, replay of the retired credential grants no authority.
    assert.ok((await kiosk("info")).error);
    await as(0);
    await manage("revoke", { kiosk_id: k.id });
    await service();
    assert.ok((await kiosk("info", {}, digest("rotated"))).error);
    assert.ok(
      (
        await kiosk(
          "punch",
          {
            action: "in",
            request_id: randomUUID(),
            challenge_hash: digest("challenge"),
          },
          digest("rotated"),
        )
      ).error,
    );
    await as(0);
    const next = await manage("enroll", {
      name: "Reauthorized",
      token_hash: digest("device"),
    });
    assert.notEqual(next.id, k.id);
    await db.exec("reset role");
    await db.query(
      "update public.time_kiosks set expires_at=now()-interval '1 second' where id=$1",
      [next.id],
    );
    await service();
    // Legacy deadline is no longer an authorization boundary (including offline devices).
    assert.ok(!(await kiosk("info")).error);
    await as(0);
    await manage("settings", { enabled: false });
    await db.exec("reset role");
    await db.query(
      "update shiftly_private.kiosk_credentials set attempts=120 where kiosk_id=$1",
      [next.id],
    );
    await service();
    assert.equal(
      (await kiosk("end")).ok,
      true,
      "exit survives disabled workplace and throttling",
    );
    assert.ok(
      (
        await kiosk("punch", {
          action: "in",
          request_id: randomUUID(),
          challenge_hash: digest("challenge"),
        })
      ).error,
    );
    await db.exec("reset role");
    assert.ok(
      (
        await row("select revoked_at from public.time_kiosks where id=$1", [
          next.id,
        ])
      ).revoked_at,
    );
    assert.equal(
      (
        await row(
          "select count(*)::int n from public.time_audit where kiosk_id=$1 and action='end'",
          [next.id],
        )
      ).n,
      1,
    );
    await as(0);
    await manage("settings", { enabled: true });
    const third = await manage("enroll", {
      name: "Archive Test",
      token_hash: digest("archive"),
    });
    await db.exec("reset role");
    await db.query(
      "update public.employees set archived_at=now(),archived_user_id=user_id,user_id=null where organization_id=$1 and id=$2",
      [org, employee],
    );
    await service();
    assert.equal(
      (
        await kiosk(
          "lookup",
          { lookup_hash: digest("lookup") },
          digest("archive"),
        )
      ).hash,
      "invalid",
    );
    assert.ok(
      (
        await kiosk(
          "authorize",
          {
            employee_id: employee,
            verified_hash: pinHash,
            challenge_hash: digest("challenge"),
          },
          digest("archive"),
        )
      ).error,
    );
    await db.exec("reset role");
    await assert.rejects(
      db.query("delete from public.time_punch_events"),
      /immutable/,
    );
    await assert.rejects(
      db.query("update public.time_audit set reason='overwrite'"),
      /immutable/,
    );
    assert.equal(
      (await row("select count(*)::int n from public.time_sessions")).n,
      1,
    );
    assert.ok(third.id);
    await as(0);
    const currentCard = await row(
      "select * from public.time_sessions where id=$1",
      [card.id],
    );
    await manage("void", {
      session_id: card.id,
      revision: currentCard.revision,
      reason: "Synthetic invalid record void",
    });
    assert.ok(
      (
        await row("select voided_at from public.time_sessions where id=$1", [
          card.id,
        ])
      ).voided_at,
    );
    await assert.rejects(
      manage("approve", {
        session_id: card.id,
        revision: currentCard.revision + 1,
      }),
      /Voided/,
    );
    await manage("correct", {
      employee_id: employee,
      clock_in: corrected.clock_in,
      clock_out: corrected.clock_out,
      breaks: [],
      reason: "Replace synthetic invalid record",
    });
    await db.exec("reset role");
    await db.query(
      "update public.employees set archived_at=null,user_id=$1 where organization_id=$2 and id=$3",
      [users[1], org, employee],
    );
    await service();
    assert.equal(
      (
        await kiosk(
          "lookup",
          { lookup_hash: digest("lookup") },
          digest("archive"),
        )
      ).hash,
      "invalid",
      "restore cannot revive an old PIN",
    );
    await as(0);
    await manage("pin", {
      employee_id: employee,
      lookup_hash: digest("lookup"),
      pin_hash: pinHash,
    });
    await service();
    assert.ok(
      !(
        await kiosk(
          "authorize",
          {
            employee_id: employee,
            verified_hash: pinHash,
            challenge_hash: digest("challenge"),
          },
          digest("archive"),
        )
      ).error,
    );
    await db.exec("reset role");
    await db.query(
      "delete from public.memberships where organization_id=$1 and user_id=$2",
      [org, users[1]],
    );
    await service();
    assert.ok(
      (
        await kiosk(
          "punch",
          {
            action: "in",
            request_id: randomUUID(),
            challenge_hash: digest("challenge"),
          },
          digest("archive"),
        )
      ).error,
    );
    await db.exec("reset role");
    await db.query("insert into public.memberships values($1,$2,'employee')", [
      org,
      users[1],
    ]);
    await service();
    assert.equal(
      (
        await kiosk(
          "lookup",
          { lookup_hash: digest("lookup") },
          digest("archive"),
        )
      ).hash,
      "invalid",
      "reconnecting cannot revive a disconnected PIN",
    );
    await as(0);
    await manage("correct", {
      employee_id: users[2],
      clock_in: "2026-11-02T06:00:00Z",
      clock_out: "2026-11-02T10:00:00Z",
      breaks: [],
      reason: "Synthetic separate employee card",
    });
    await as(1);
    assert.ok(
      (
        await db.query("select employee_id from public.time_sessions")
      ).rows.every((r: any) => r.employee_id === employee),
    );
  } finally {
    await db.close();
  }
});
