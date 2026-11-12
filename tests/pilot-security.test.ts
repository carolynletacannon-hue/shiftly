import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { migrationDatabase } from "./support/migration-database";
import config from "../next.config";

test("management pages reject framing", async () => {
  const headers = (await config.headers!())[0].headers;
  assert.ok(headers.some(h => h.key === "X-Frame-Options" && h.value === "DENY"));
  assert.ok(headers.some(h => h.key === "Content-Security-Policy" && h.value === "frame-ancestors 'none'"));
});

test("pilot: complete migration chain, two workplaces, role matrix, privacy and RPC compatibility", async () => {
  const db = await migrationDatabase();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon,service_role;
      grant execute on function auth.uid() to authenticated,anon,service_role;
      -- Exercise Supabase-shaped default grants, absent from older fixtures.
      alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    const migrations = (await readdir(dir)).filter(f => f.endsWith(".sql")).sort();
    const hardening = migrations.find(f=>f.endsWith("_workforce_pilot_security.sql"))!;
    for (const f of migrations.filter(f=>f!==hardening))
      await db.exec(await readFile(new URL(f, dir), "utf8"));
    const users = Array.from({length: 7}, () => randomUUID());
    const [owner, manager, employee, coworker, outsider, invited, unverified] = users;
    for (const [i, id] of users.entries())
      await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)",
        [id, `pilot${i}@example.test`, id === unverified ? null : new Date()]);
    const as = async (id: string, role = "authenticated") => {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
      await db.exec(`set role ${role}`);
    };
    const row = async (sql: string, args: unknown[] = []) => (await db.query<any>(sql,args)).rows[0];
    const rpc = async (name: string, org: string, command: string, payload: object = {}, revision?: number) =>
      (await row(`select public.${name}($1,$2,$3${name === "schedule_command" ? ",$4" : ""}) r`,
        [org,command,JSON.stringify(payload),...(name === "schedule_command" ? [revision ?? null] : [])])).r;
    await as(owner);
    const a = (await row("select public.create_workspace('Synthetic Pilot Alpha','America/Denver') id")).id;
    await as(outsider);
    const b = (await row("select public.create_workspace('Synthetic Pilot Beta','UTC') id")).id;
    await db.exec("reset role");
    await db.query("insert into public.memberships values($1,$2,'manager'),($1,$3,'employee'),($1,$4,'employee')", [a,manager,employee,coworker]);
    await as(owner);
    await rpc("schedule_command",a,"create",{week_start:"2034-12-31"});
    const template = (await row("select id from public.shift_templates where organization_id=$1 and name='Morning'",[a])).id;
    for (const weekday of [1,2]) await rpc("schedule_command",a,"requirement_save",{template_id:template,weekday,required_count:1});
    const schedule = await rpc("schedule_command",a,"create",{week_start:"2035-01-07"});
    const slots = (await db.query<any>("select * from public.shifts where schedule_id=$1 order by starts_at,id",[schedule.id])).rows;
    assert.ok(slots.length >= 2);
    const revision = async () => (await row("select revision from public.schedules where id=$1",[schedule.id])).revision;
    for (const [slot, who] of [[slots[0],employee],[slots.find((s:any) => s.starts_at > slots[0].ends_at)!,coworker]] as const) {
      assert.ok(slot);
      await rpc("schedule_command",a,"assign",{schedule_id:schedule.id,id:slot.id,employee_id:who},await revision());
    }
    await rpc("schedule_command",a,"publish",{schedule_id:schedule.id,allow_incomplete:true},await revision());
    await db.exec("reset role");
    // Main may already have applied employee colors before this older migration.
    assert.equal((await db.query("update public.employees set color_key='teal' where organization_id=$1 and user_id=$2 returning id", [a, employee])).rows.length, 1);
    const rosterBeforeUpgrade = (await db.query("select * from public.employees order by organization_id,id")).rows;
    const beforeUpgrade = (await db.query("select * from public.published_shifts order by id")).rows;
    await db.exec(await readFile(new URL(hardening,dir),"utf8"));
    assert.deepEqual((await db.query("select * from public.published_shifts order by id")).rows,beforeUpgrade);
    assert.deepEqual((await db.query("select * from public.employees order by organization_id,id")).rows,rosterBeforeUpgrade);
    const afterUpgradeUser = randomUUID();
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'after-upgrade@example.test',now())",[afterUpgradeUser]);
    assert.equal((await row("select id from public.profiles where id=$1",[afterUpgradeUser])).id,afterUpgradeUser);
    await as(owner);
    // Populate distinct wage records so privacy checks cannot pass on empty tables.
    await rpc("payroll_manage",a,"settings",{frequency:"weekly",anchor:"2035-01-07",timezone:"America/Denver",workweek_day:1,workweek_time:"00:00",rule:"federal-weekly-confirmed",employee_access:true,reason:"Synthetic pilot setup"});
    for (const who of [employee,coworker]) await rpc("payroll_manage",a,"rate",{employee_id:who,effective_at:"2035-01-01T00:00Z",cents:"2000",classification:"hourly_nonexempt",reason:"Synthetic wage"});
    await as(employee);
    const ownRates = (await db.query<any>("select * from public.payroll_rates")).rows;
    assert.equal(ownRates.length,1);
    assert.equal(ownRates[0].employee_id,employee);
    assert.equal((await db.query("select * from public.payroll_reports")).rows.length,0);
    const payroll = (await row("select public.payroll_input($1) r",[a])).r;
    assert.equal(payroll.rates.length,1);
    assert.ok(payroll.employees.every((e:any)=>e.user_id===employee));
    assert.ok((await db.query("select id from public.published_shifts where organization_id=$1",[a])).rows.length >= 2);
    assert.equal((await db.query("select id from public.shifts")).rows.length,0);
    assert.equal((await db.query("select id from public.organizations where id=$1",[b])).rows.length,0);
    assert.equal((await row("select public.workspace_role_for($1) r",[b])).r,null);
    for (const sql of ["select email from public.employees", "select phone from public.employees", "select token_hash from public.invitations"])
      await assert.rejects(db.query(sql),/permission denied/);
    // Profiles contain names, never emails; membership reads expose role + IDs only.
    const profileColumns = (await db.query<any>("select column_name from information_schema.columns where table_schema='public' and table_name='profiles'")).rows.map(r=>r.column_name);
    assert.deepEqual(profileColumns.sort(),["display_name","id"]);
    for (const [name,command] of [["schedule_command","publish"],["payroll_manage","settings"],["time_clock_manage","enroll"],["employee_lifecycle","archive"]]) {
      if (name === "employee_lifecycle")
        await assert.rejects(db.query("select public.employee_lifecycle($1,$2,'archive')",[a,coworker]),/Permission denied/);
      else await assert.rejects(rpc(name,a,command,{schedule_id:schedule.id}),/permission|Manager/i);
    }
    await assert.rejects(db.query("update public.published_shifts set notes='forged'"),/permission denied/);
    await assert.rejects(db.query("select public.employee_contacts($1)",[a]),/Permission denied/);
    await assert.rejects(db.query("select public.change_member_role($1,$2,'manager')",[a,employee]),/Permission denied/);
    await assert.rejects(db.query("select public.issue_invitation($1,'no@example.test','employee',$2,null)",[a,"a".repeat(64)]),/Permission denied/);
    const off = await rpc("time_off_command",a,"submit",{employee_id:employee,start_date:"2036-01-01",end_date:"2036-01-01",full_day:true,notes:"Synthetic private explanation"});
    await assert.rejects(rpc("time_off_command",a,"approve",{id:off.id}),/permission/i);
    const coverage = await rpc("shift_request_command",a,"coverage",{shift_id:slots[0].id});
    await as(coworker);
    assert.equal((await db.query("select notes from public.time_off_requests where id=$1",[off.id])).rows.length,0);
    const accepted = await rpc("shift_request_command",a,"accept",{request_id:coverage.id});
    assert.equal(accepted.status,"pending");
    await assert.rejects(rpc("shift_request_command",a,"approve",{request_id:coverage.id}),/Permission denied/);
    await as(manager);
    await assert.rejects(db.query("select public.change_member_role($1,$2,'manager')",[a,employee]),/Permission denied/);
    await assert.rejects(db.query("select public.change_member_role($1,$2,'employee')",[b,outsider]),/Permission denied/);
    await rpc("shift_request_command",a,"approve",{request_id:coverage.id});
    assert.equal((await row("select employee_id from public.published_shifts where id=$1",[slots[0].id])).employee_id,coworker);
    const digest = (s:string) => createHash("sha256").update(s).digest("hex");
    const invite = async (who:number, token:string) => (await row("select public.issue_invitation($1,$2,'employee',$3,null) id",[a,`pilot${who}@example.test`,digest(token)])).id;
    const invitation = await invite(5,"single-use");
    await as(employee);
    await assert.rejects(db.query("select public.revoke_invitation($1)",[invitation]),/Permission denied/);
    await as(coworker);
    await assert.rejects(db.query("select public.accept_invitation($1)",[digest("single-use")]),/invalid/i);
    await as(invited);
    await assert.rejects(db.query("select public.accept_invitation($1)",[digest("tampered")]),/invalid/i);
    await db.query("select public.accept_invitation($1)",[digest("single-use")]);
    assert.equal((await row("select public.workspace_role_for($1) r",[a])).r,"employee");
    await assert.rejects(db.query("select public.accept_invitation($1)",[digest("single-use")]),/invalid/i);
    await as(manager);
    const revoked = await invite(6,"revoked");
    await db.query("select public.revoke_invitation($1)",[revoked]);
    await as(unverified);
    await assert.rejects(db.query("select public.accept_invitation($1)",[digest("revoked")]),/Verify/);
    await db.exec("reset role");
    await db.query("update auth.users set email_confirmed_at=now() where id=$1",[unverified]);
    await as(unverified);
    await assert.rejects(db.query("select public.accept_invitation($1)",[digest("revoked")]),/invalid/i);
    await db.exec("reset role");
    await db.query("update public.invitations set revoked_at=null,expires_at=now()-interval '1 second' where id=$1",[revoked]);
    await as(unverified);
    await assert.rejects(db.query("select public.accept_invitation($1)",[digest("revoked")]),/invalid/i);
    await as(owner);
    await db.query("select public.change_member_role($1,$2,'employee')",[a,manager]);
    await as(manager);
    await assert.rejects(db.query("select public.revoke_invitation($1)",[revoked]),/Permission denied/);
    await db.exec("reset role");
    // A still-valid caller JWT cannot bypass a removed membership.
    await db.query("delete from public.memberships where organization_id=$1 and user_id=$2",[a,invited]);
    await as(invited);
    assert.equal((await db.query("select id from public.published_shifts where organization_id=$1",[a])).rows.length,0);
    await assert.rejects(rpc("time_off_command",a,"submit",{employee_id:invited}),/permission/i);
    await as(outsider);
    await assert.rejects(rpc("shift_request_command",a,"coverage",{shift_id:slots[0].id}),/Permission denied/);
    for (const table of ["kiosk_credentials","employee_pins","calendar_subscriptions","calendar_events","calendar_request_buckets","notification_schedule_snapshots"])
      await assert.rejects(db.query(`select * from shiftly_private.${table}`),/permission denied/);
    await assert.rejects(db.query("select * from public.shift_email_deliveries"),/permission denied/);
    await assert.rejects(db.query("select public.time_clock_kiosk('forged','info','{}')"),/permission denied/);
    await db.exec("reset role");
    const internal = (await db.query<any>("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='shiftly_private' and c.relkind='r'")).rows;
    assert.ok(internal.length >= 6);
    assert.ok(internal.every(t=>t.relrowsecurity));
    assert.equal((await row("select has_function_privilege('authenticated','shiftly_private.bootstrap_profile()','execute') ok")).ok,false);
    assert.equal((await row("select to_regprocedure('public.bootstrap_profile()') p")).p,null);
    for (const name of ["workspace_role_for","create_workspace","change_member_role","revoke_invitation"])
      assert.equal((await row("select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=$1",[name])).prosecdef,false);
    assert.deepEqual((await db.query("select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and prosecdef and has_function_privilege('authenticated',p.oid,'execute')")).rows,[]);
    await as("","anon");
    await assert.rejects(db.query("select public.create_workspace('No','UTC')"),/permission denied/);
    await assert.rejects(db.query("select public.workspace_role_for($1)",[a]),/permission denied/);
  } finally { await db.close(); }
});
