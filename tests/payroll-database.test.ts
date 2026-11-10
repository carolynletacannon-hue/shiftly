import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { migrationDatabase } from "./support/migration-database";
import { calculate, type Input } from "../lib/payroll/engine";
test("payroll database: RLS, append-only rates, snapshots, revision approval, isolation and service boundary", async () => {
  const db = await migrationDatabase();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const f of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(await readFile(new URL(f, dir), "utf8"));
    const row = async (sql: string, args: unknown[] = []) =>
      (await db.query<any>(sql, args)).rows[0];
    const users = Array.from({ length: 4 }, () => randomUUID());
    for (const [i, u] of users.entries())
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [u, `payroll${i}@example.test`],
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
      await row("select public.create_workspace('Synthetic Payroll','UTC') id")
    ).id;
    await as(3);
    const other = (
      await row("select public.create_workspace('Synthetic Other','UTC') id")
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
    const manage = async (command: string, payload: object = {}, o = org) =>
      (
        await row("select public.payroll_manage($1,$2,$3) r", [
          o,
          command,
          JSON.stringify({
            reason: "Synthetic review explanation",
            ...payload,
          }),
        ])
      ).r;
    const source = async (o = org) =>
      (await row("select public.payroll_input($1) r", [o])).r as Input;
    const config = {
      frequency: "weekly",
      anchor: "2026-01-05",
      timezone: "UTC",
      workweek_day: 1,
      workweek_time: "00:00",
      rule: "federal-weekly-confirmed",
      employee_access: true,
    };
    await as(0);
    await manage("settings", config);
    await manage("rate", {
      employee_id: employee,
      effective_at: "2026-01-01T00:00Z",
      cents: "2000",
      classification: "hourly_nonexempt",
    });
    await as(1);
    assert.equal((await source()).rates.length, 1);
    assert.ok((await source()).employees.every((e) => e.user_id === users[1]));
    await assert.rejects(
      () => manage("rate", { employee_id: employee }),
      /Manager/,
    );
    await assert.rejects(
      () => db.exec("update public.payroll_rates set cents=1"),
      /permission denied/,
    );
    await assert.rejects(
      () =>
        db.query(
          "select public.payroll_approve($1,$2,'{}','{}','forged approval')",
          [org, users[1]],
        ),
      /permission denied/,
    );
    await as(3);
    assert.equal(await source(org), null);
    assert.equal(
      (await row("select count(*) n from public.payroll_rates")).n,
      0,
    );
    await assert.rejects(() => manage("settings", config, org), /Manager/);
    await as(2);
    assert.equal((await source()).rates.length, 1);
    await assert.rejects(
      () =>
        manage(
          "rate",
          {
            employee_id: employee,
            effective_at: "2026-01-01T00:00Z",
            cents: "2000",
            classification: "hourly_nonexempt",
          },
          other,
        ),
      /Manager/,
    );
    await as(0);
    await manage("settings", { ...config, employee_access: false });
    await as(1);
    assert.equal((await source()).rates.length, 0);
    await as(0);
    await manage("settings", config);
    await db.exec("reset role");
    const session = (
      await row(
        "insert into public.time_sessions(organization_id,employee_id,clock_in,clock_out,approved_at,approved_by) values($1,$2,'2026-01-05T00:00Z','2026-01-05T08:00Z',now(),$3) returning id",
        [org, employee, users[0]],
      )
    ).id;
    await as(0);
    const original = await source();
    const report = calculate(
      original,
      "2026-01-05T00:00Z",
      "2026-01-12T00:00Z",
    );
    assert.equal(report.rows[0].totalCents, "16000");
    assert.deepEqual(report.warnings, []);
    const approve = async (
      s: Input,
      r = calculate(s, "2026-01-05T00:00Z", "2026-01-12T00:00Z"),
    ) => {
      await db.exec("reset role;set role service_role");
      return (
        await row("select public.payroll_approve($1,$2,$3,$4,$5) id", [
          org,
          users[0],
          JSON.stringify(s),
          JSON.stringify(r),
          "Synthetic approved preparation",
        ])
      ).id;
    };
    const first = await approve(original, report);
    await as(1);
    assert.equal(
      (await row("select count(*) n from public.payroll_reports")).n,
      0,
    );
    await as(3);
    assert.equal(
      (await row("select count(*) n from public.payroll_reports")).n,
      0,
    );
    await as(0);
    assert.equal(
      (
        await row("select snapshot from public.payroll_reports where id=$1", [
          first,
        ])
      ).snapshot.rows[0].totalCents,
      "16000",
    );
    await assert.rejects(
      () => db.exec("delete from public.payroll_reports"),
      /permission denied/,
    );
    await assert.rejects(() => approve(original, report), /Reopen/);
    // Actual time reporting remains writable after approval. Old approved snapshot stays unchanged.
    await db.exec("reset role");
    await db.query(
      "update public.time_sessions set clock_out=$1,approved_at=null,revision=revision+1 where id=$2",
      ["2026-01-05T09:00Z", session],
    );
    await assert.rejects(() => approve(original, report), /Sources changed/);
    await as(0);
    const changed = await source();
    assert.match(
      calculate(changed, report.start, report.end).warnings.join(),
      /Unapproved/,
    );
    await assert.rejects(() => approve(changed), /Resolve exceptions/);
    await as(0);
    await manage("reopen", { report_id: first });
    await db.exec("reset role");
    await db.query(
      "update public.time_sessions set approved_at=now() where id=$1",
      [session],
    );
    await as(0);
    const corrected = await source();
    const second = await approve(corrected);
    await as(0);
    const reports = (
      await db.query<any>(
        "select version,snapshot from public.payroll_reports order by version",
      )
    ).rows;
    assert.equal(reports.length, 2);
    assert.equal(reports[0].snapshot.rows[0].totalCents, "16000");
    assert.equal(reports[1].snapshot.rows[0].totalCents, "18000");
    assert.notEqual(first, second);
    // Corrections to rates append; same effective instant resolves to latest insertion.
    await manage("rate", {
      employee_id: employee,
      effective_at: "2026-01-01T00:00Z",
      cents: "2100",
      classification: "hourly_nonexempt",
    });
    const revised = await source();
    assert.equal(revised.rates.length, 2);
    assert.equal(
      calculate(revised, report.start, report.end).rows[0].totalCents,
      "18900",
    );
    const ownerEmployee = (
      await row(
        "select id from public.employees where organization_id=$1 and user_id=$2",
        [org, users[0]],
      )
    ).id;
    await manage("rate", {
      employee_id: ownerEmployee,
      effective_at: "2026-01-01T00:00Z",
      cents: "9999",
      classification: "hourly_nonexempt",
    });
    await as(1);
    assert.ok((await source()).rates.every((r) => r.employee_id === employee));
    assert.equal((await source()).rates.length, 2);
    await as(0);
    await assert.rejects(
      () =>
        manage(
          "rate",
          {
            employee_id: employee,
            effective_at: "2026-01-01T00:00Z",
            cents: "2000",
            classification: "hourly_nonexempt",
          },
          other,
        ),
      /Manager/,
    );
    await db.exec("reset role");
    await assert.rejects(
      () => db.exec("update public.payroll_rates set cents=1"),
      /immutable/,
    );
    await db.query(
      "update public.employees set archived_at=now() where id=$1",
      [employee],
    );
    await as(0);
    assert.equal((await source()).rates.length, 3);
    assert.equal(
      calculate(await source(), report.start, report.end).rows[0].archived,
      true,
    );
    await db.exec("reset role;set role anon");
    await assert.rejects(
      () => db.exec("select * from public.payroll_rates"),
      /permission denied/,
    );
    await assert.rejects(
      () => db.query("select public.payroll_input($1)", [org]),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});
