import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { migrationDatabase } from "./support/migration-database";
import { calculate, type Input } from "../lib/payroll/engine";
test("timecard approval: handoffs, overnight overlaps, automatic overtime, exceptions, historical/bulk review and payroll", async () => {
  const db = await migrationDatabase();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    let upgrade = "";
    for (const f of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(new URL(f, dir), "utf8");
      if (f.includes("timecard_approval_workflow")) upgrade = sql;
      else await db.exec(sql);
    }
    const row = async (sql: string, args: unknown[] = []) =>
      (await db.query<any>(sql, args)).rows[0];
    const users = Array.from({ length: 4 }, () => randomUUID());
    for (const [i, u] of users.entries())
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())",
        [u, `approval${i}@example.test`],
      );
    const as = async (i: number) => {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        users[i],
      ]);
      await db.exec("set role authenticated");
    };
    await as(0);
    const org = (
      await row("select public.create_workspace('Synthetic Approval','UTC') id")
    ).id;
    await as(3);
    const other = (
      await row("select public.create_workspace('Synthetic Other','UTC') id")
    ).id;
    await db.exec("reset role");
    await db.query(
      "insert into public.memberships values($1,$2,'employee'),($1,$3,'employee')",
      [org, users[1], users[2]],
    );
    const employees = (
      await db.query<any>(
        "select id,user_id from public.employees where organization_id=$1",
        [org],
      )
    ).rows;
    const employee = (i: number) =>
      employees.find((e) => e.user_id === users[i]).id;
    const manage = async (command: string, payload: object = {}, o = org) =>
      (
        await row("select public.time_clock_manage($1,$2,$3) r", [
          o,
          command,
          JSON.stringify(payload),
        ])
      ).r;
    await as(0);
    await manage("settings", { enabled: true });
    const kiosk = (
      await manage("enroll", {
        name: "Synthetic Shared Clock",
        token_hash: "a".repeat(64),
      })
    ).id;
    const otherKiosk = (
      await manage("enroll", {
        name: "Synthetic Other Clock",
        token_hash: "b".repeat(64),
      })
    ).id;
    const card = async (id: string) =>
      await row("select * from public.time_sessions where id=$1", [id]);
    const event = async (
      id: string,
      action: string,
      at: string,
      device = kiosk,
    ) =>
      db.query(
        "insert into public.time_punch_events(organization_id,session_id,kiosk_id,request_id,action,occurred_at,result) values($1,$2,$3,$4,$5,$6,'{\"ok\":true}')",
        [org, id, device, randomUUID(), action, at],
      );
    const open = async (e: string, at: string) => {
      await db.exec("reset role");
      const s = await row(
        "insert into public.time_sessions(organization_id,employee_id,kiosk_id,clock_in) values($1,$2,$3,$4) returning *",
        [org, e, kiosk, at],
      );
      await event(s.id, "in", at);
      return s.id;
    };
    const close = async (id: string, at: string, device = kiosk) => {
      await db.exec("reset role");
      await db.query(
        "update public.time_sessions set clock_out=$2,revision=revision+1 where id=$1",
        [id, at],
      );
      await event(id, "out", at, device);
      return card(id);
    };
    const legacy = await open(employee(1), "2025-12-29T08:00Z");
    await close(legacy, "2025-12-29T16:00Z");
    assert.equal((await card(legacy)).approved_at, null);
    await db.exec(upgrade);
    await as(0);
    await manage("settings", { enabled: false });
    assert.equal(
      (await manage("bulk_preview", { from: "2026-01-01", to: "2026-01-31" }))
        .disabled,
      true,
    );
    await manage("settings", { enabled: true });
    await db.exec("reset role");
    assert.equal(
      (await card(legacy)).approved_at,
      null,
      "migration never approves historical pending cards",
    );
    // Swing and night audit overlap across midnight, closing in either order.
    const swing = await open(employee(1), "2026-01-05T15:00Z");
    const night = await open(employee(2), "2026-01-05T23:00Z");
    const approvedSwing = await close(swing, "2026-01-05T23:15Z");
    assert.ok(approvedSwing.approved_at);
    assert.equal(approvedSwing.approval_source, "automatic");
    assert.equal((await card(night)).clock_out, null);
    assert.ok((await close(night, "2026-01-06T07:00Z")).approved_at);
    // The later starter can also clock out before the earlier starter.
    const early = await open(employee(1), "2026-01-06T15:00Z");
    const late = await open(employee(2), "2026-01-06T16:00Z");
    assert.ok((await close(late, "2026-01-06T17:00Z", otherKiosk)).approved_at);
    assert.ok((await close(early, "2026-01-06T23:15Z")).approved_at);
    for (const d of ["07", "08", "09"]) {
      const id = await open(employee(1), `2026-01-${d}T15:00Z`);
      assert.ok((await close(id, `2026-01-${d}T23:15Z`)).approved_at);
    }
    await as(0);
    for (const [i, cents] of [
      [1, "2000"],
      [2, "2500"],
    ] as const)
      await db.query("select public.payroll_manage($1,$2,$3)", [
        org,
        "rate",
        JSON.stringify({
          employee_id: employee(i),
          cents,
          effective_at: "2020-01-01T00:00Z",
          classification: "hourly_nonexempt",
          reason: "Synthetic hourly wage",
        }),
      ]);
    await db.query("select public.payroll_manage($1,$2,$3)", [
      org,
      "settings",
      JSON.stringify({
        frequency: "weekly",
        anchor: "2026-01-05",
        timezone: "UTC",
        workweek_day: 1,
        workweek_time: "00:00",
        rule: "federal-weekly-confirmed",
        employee_access: true,
        reason: "Synthetic payroll settings",
      }),
    ]);
    const input = (await row("select public.payroll_input($1) r", [org]))
      .r as Input;
    const report = calculate(input, "2026-01-05T00:00Z", "2026-01-12T00:00Z");
    assert.deepEqual(report.warnings, []);
    const wages = report.rows.find((r) => r.employee === employee(1))!;
    assert.equal(
      wages.overtimeNs,
      (BigInt(125) * BigInt(36000000000)).toString(),
    );
    assert.equal(wages.totalCents, "83750");
    assert.equal(
      report.rows.find((r) => r.employee === employee(2))!.totalCents,
      "22500",
    );
    assert.equal(
      (await row("select count(*)::int n from public.payroll_reports")).n,
      0,
      "automatic timecard approval never approves payroll reports",
    );
    // Correction requests clear approval and bump revisions; unresolved requests block all approvals.
    await as(1);
    await manage("request", {
      session_id: swing,
      reason: "Please review my recorded time",
    });
    const requested = await card(swing);
    assert.equal(requested.approved_at, null);
    assert.ok(requested.revision > approvedSwing.revision);
    await as(0);
    await assert.rejects(
      () =>
        manage("approve", { session_id: swing, revision: requested.revision }),
      /Pending correction/,
    );
    const corrected = {
      session_id: night,
      revision: (await card(night)).revision,
      clock_in: "2026-01-05T23:00Z",
      clock_out: "2026-01-06T07:15Z",
      breaks: [],
      reason: "Synthetic correction for review",
    };
    await manage("correct", corrected);
    assert.equal((await card(night)).approved_at, null);
    await manage("approve", {
      session_id: night,
      revision: (await card(night)).revision,
    });
    assert.equal((await card(night)).approval_source, "manager");
    const already = await card(night);
    assert.equal(
      (
        await manage("approve", {
          session_id: night,
          revision: already.revision,
        })
      ).already_approved,
      true,
    );
    assert.equal((await card(night)).revision, already.revision);
    // Valid completed breaks auto-approve. An incomplete break keeps the whole card in review.
    const breaks = await open(employee(2), "2026-01-07T08:00Z");
    await db.query(
      "insert into public.time_breaks(organization_id,session_id,starts_at,ends_at)values($1,$2,$3,$4)",
      [org, breaks, "2026-01-07T12:00Z", "2026-01-07T12:30Z"],
    );
    await event(breaks, "break_start", "2026-01-07T12:00Z");
    await event(breaks, "break_end", "2026-01-07T12:30Z");
    assert.ok((await close(breaks, "2026-01-07T16:00Z")).approved_at);
    const invalid = await open(employee(2), "2026-01-08T08:00Z");
    await db.query(
      "insert into public.time_breaks(organization_id,session_id,starts_at)values($1,$2,$3)",
      [org, invalid, "2026-01-08T12:00Z"],
    );
    await event(invalid, "break_start", "2026-01-08T12:00Z");
    assert.equal((await close(invalid, "2026-01-08T16:00Z")).approved_at, null);
    await as(0);
    await assert.rejects(
      () => manage("approve", { session_id: invalid, revision: 0 }),
      /changed/,
    );
    await assert.rejects(
      async () =>
        manage("approve", {
          session_id: invalid,
          revision: (await card(invalid)).revision,
        }),
      /breaks/,
    );
    const editedOpen = await open(employee(2), "2026-01-09T08:00Z");
    await as(0);
    await manage("correct", {
      session_id: editedOpen,
      revision: (await card(editedOpen)).revision,
      clock_in: "2026-01-09T08:00Z",
      clock_out: null,
      breaks: [],
      reason: "Manager reviewed an open timecard",
    });
    assert.equal(
      (await close(editedOpen, "2026-01-09T16:00Z")).approved_at,
      null,
      "edited open timecards never auto-approve on later clock-out",
    );
    const pendingOpen = await open(employee(2), "2026-01-10T08:00Z");
    await as(2);
    await manage("request", {
      session_id: pendingOpen,
      reason: "Please check this open timecard",
    });
    assert.equal(
      (await close(pendingOpen, "2026-01-10T16:00Z")).approved_at,
      null,
      "pending corrections block automatic approval",
    );
    const missing = await open(employee(1), "2026-01-10T08:00Z");
    await as(0);
    await assert.rejects(
      async () =>
        manage("approve", {
          session_id: missing,
          revision: (await card(missing)).revision,
        }),
      /Missing clock-out/,
    );
    const toVoid = await open(employee(2), "2026-01-11T08:00Z");
    await close(toVoid, "2026-01-11T16:00Z");
    await as(0);
    await manage("void", {
      session_id: toVoid,
      revision: (await card(toVoid)).revision,
      reason: "Synthetic duplicate record reviewed",
    });
    assert.equal((await card(toVoid)).approved_at, null);
    assert.ok((await card(toVoid)).voided_at);
    // Same-employee duplicate intervals invalidate prior approval and block manual/bulk approval.
    const duplicate = await open(employee(2), "2026-01-07T09:00Z");
    assert.equal((await card(breaks)).approved_at, null);
    assert.equal(
      (await close(duplicate, "2026-01-07T10:00Z")).approved_at,
      null,
    );
    await as(0);
    await assert.rejects(
      async () =>
        manage("approve", {
          session_id: duplicate,
          revision: (await card(duplicate)).revision,
        }),
      /Overlapping/,
    );
    // Explicit bulk review of historical valid receipts; confirmation and stale-token protection.
    const range = { from: "2025-12-29", to: "2026-01-04" };
    const preview = await manage("bulk_preview", range);
    assert.equal(preview.count, 1);
    await assert.rejects(
      () => manage("bulk_approve", { ...range, token: preview.token }),
      /confirmation/,
    );
    const result = await manage("bulk_approve", {
      ...range,
      token: preview.token,
      confirmed: true,
    });
    assert.equal(result.approved, 1);
    assert.equal((await card(legacy)).approval_source, "manager");
    await assert.rejects(
      () =>
        manage("bulk_approve", {
          ...range,
          token: preview.token,
          confirmed: true,
        }),
      /changed/,
    );
    const blocked = await manage("bulk_preview", {
      from: "2026-01-05",
      to: "2026-01-11",
    });
    assert.equal(blocked.count, 0);
    assert.ok(blocked.exceptions.some((e: any) => e.id === invalid));
    assert.ok(blocked.exceptions.some((e: any) => e.id === swing));
    await as(1);
    await assert.rejects(() => manage("bulk_preview", range), /Manager/);
    await assert.rejects(
      () =>
        manage("bulk_approve", {
          ...range,
          confirmed: true,
          token: preview.token,
        }),
      /Manager/,
    );
    await as(3);
    await assert.rejects(
      () =>
        manage("bulk_approve", {
          ...range,
          confirmed: true,
          token: preview.token,
        }),
      /Permission/,
    );
    await as(0);
    await assert.rejects(
      () => manage("bulk_preview", range, other),
      /Permission/,
    );
    await db.exec("reset role");
    assert.ok(
      (
        await row(
          "select count(*)::int n from public.time_audit where action='auto_approve'",
        )
      ).n >= 7,
    );
    assert.ok(
      (
        await row(
          "select count(*)::int n from public.time_audit where action='approval_invalidated'",
        )
      ).n >= 3,
    );
    await assert.rejects(
      () => db.exec("update public.time_punch_events set occurred_at=now()"),
      /immutable/,
    );
    await db.exec("set role authenticated");
    await assert.rejects(
      () =>
        db.query(
          "select shiftly_private.time_clock_manage_before_approval($1,'approve','{}')",
          [org],
        ),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});
