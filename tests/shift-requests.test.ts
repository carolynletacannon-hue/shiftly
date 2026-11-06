import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
test("shift transfers enforce consent, tenant permissions, revisions and single execution", async () => {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await readFile(new URL(file, dir), "utf8"));
  const users = Array.from(
    { length: 4 },
    (_, i) => `40000000-0000-0000-0000-00000000000${i + 1}`,
  );
  for (const [i, u] of users.entries())
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())",
      [u, `test${i}@example.test`],
    );
  const as = async (i: number) => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      users[i],
    ]);
    await db.exec("set role authenticated");
  };
  const row = async (sql: string, args: unknown[] = []): Promise<any> =>
    (await db.query(sql, args)).rows[0];
  await as(0);
  const org = (
    await row("select public.create_workspace('Test','America/Denver') id")
  ).id;
  await db.exec("reset role");
  for (const u of users.slice(1, 3))
    await db.query("insert into public.memberships values($1,$2,'employee')", [
      org,
      u,
    ]);
  const sid = "50000000-0000-0000-0000-000000000001",
    a = "60000000-0000-0000-0000-000000000001",
    b = "60000000-0000-0000-0000-000000000002";
  await db.query(
    "insert into public.schedules(id,organization_id,week_start,timezone,created_by,published_revision)values($1,$2,'2030-01-06','America/Denver',$3,1)",
    [sid, org, users[0]],
  );
  await db.query(
    "insert into public.published_schedules(id,organization_id,week_start,timezone,revision,published_by)values($1,$2,'2030-01-06','America/Denver',1,$3)",
    [sid, org, users[0]],
  );
  for (const [id, employee, start, end] of [
    [a, users[1], "2030-01-07T06:00Z", "2030-01-07T14:00Z"],
    [b, users[2], "2030-01-08T06:00Z", "2030-01-08T14:00Z"],
  ]) {
    await db.query(
      "insert into public.shifts(id,organization_id,schedule_id,employee_id,starts_at,ends_at)values($1,$2,$3,$4,$5,$6)",
      [id, org, sid, employee, start, end],
    );
    await db.query(
      "insert into public.published_shifts(id,organization_id,schedule_id,employee_id,starts_at,ends_at,position_name,notes)values($1,$2,$3,$4,$5,$6,'General','')",
      [id, org, sid, employee, start, end],
    );
  }
  const cmd = async (command: string, payload: object, workspace = org) =>
    (
      await row("select public.shift_request_command($1,$2,$3) r", [
        workspace,
        command,
        JSON.stringify(payload),
      ])
    ).r;
  await as(1);
  await assert.rejects(cmd("coverage", { shift_id: b }), /own/);
  await assert.rejects(
    cmd("policy", { revision: 1, require_manager: false }),
    /Permission/,
  );
  let r = await cmd("coverage", { shift_id: a });
  await assert.rejects(cmd("approve", { request_id: r.id }), /Permission/);
  await as(2);
  r = await cmd("accept", { request_id: r.id });
  assert.equal(r.status, "pending");
  assert.equal(
    (
      await row("select employee_id from public.published_shifts where id=$1", [
        a,
      ])
    ).employee_id,
    users[1],
  );
  await as(0);
  r = await cmd("approve", { request_id: r.id });
  assert.equal(r.status, "completed");
  assert.equal(r.approved_by, users[0]);
  await assert.rejects(cmd("approve", { request_id: r.id }), /no longer/);
  assert.equal(
    (
      await row("select employee_id from public.published_shifts where id=$1", [
        a,
      ])
    ).employee_id,
    users[2],
  );
  // Policy changes never convert an already-pending request to automatic approval.
  await as(2);
  r = await cmd("coverage", { shift_id: b });
  await as(1);
  r = await cmd("accept", { request_id: r.id });
  await as(0);
  await cmd("policy", { revision: 1, require_manager: false });
  assert.equal(
    (await row("select status from public.shift_requests where id=$1", [r.id]))
      .status,
    "pending",
  );
  await cmd("deny", { request_id: r.id });
  // A fresh swap carries requester consent; only the other owner may accept.
  await as(2);
  r = await cmd("coverage", { shift_id: a });
  await as(1);
  r = await cmd("accept", { request_id: r.id });
  assert.equal(r.status, "completed");
  assert.equal(r.approved_by, null);
  await as(1);
  r = await cmd("swap", { shift_id: a, other_shift_id: b });
  await assert.rejects(cmd("accept", { request_id: r.id }), /Permission/);
  await as(2);
  r = await cmd("accept", { request_id: r.id });
  assert.equal(r.status, "completed");
  // Competing acceptances have exactly one winner, even with automatic finalization.
  await assert.rejects(cmd("coverage", { shift_id: b }), /own/);
  await as(1);
  r = await cmd("coverage", { shift_id: b });
  await as(2);
  const race = await Promise.allSettled([
    cmd("accept", { request_id: r.id }),
    cmd("accept", { request_id: r.id }),
  ]);
  assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
  // Hard conflicts are rechecked at consent and approval, using actual UTC intervals.
  await as(2);
  r = await cmd("coverage", { shift_id: a });
  await db.exec("reset role");
  await db.query(
    "insert into public.time_off_requests(organization_id,employee_id,start_date,end_date,full_day,timezone,created_by,starts_at,ends_at,status)values($1,$2,'2030-01-07','2030-01-07',false,'America/Denver',$2,'2030-01-07T07:00Z','2030-01-07T08:00Z','approved')",
    [org, users[1]],
  );
  await as(1);
  await assert.rejects(
    cmd("accept", { request_id: r.id }),
    /Approved time off/,
  );
  await db.exec("reset role");
  await db.query(
    "delete from public.time_off_requests where organization_id=$1",
    [org],
  );
  await as(0);
  await cmd("policy", { revision: 2, require_manager: true });
  await as(1);
  r = await cmd("accept", { request_id: r.id });
  assert.equal(r.status, "pending");
  await as(0);
  // A conflicting time-off approval after consent blocks finalization.
  await db.exec("reset role");
  await db.query(
    "insert into public.time_off_requests(organization_id,employee_id,start_date,end_date,full_day,timezone,created_by,starts_at,ends_at,status)values($1,$2,'2030-01-07','2030-01-07',false,'America/Denver',$2,'2030-01-07T07:00Z','2030-01-07T08:00Z','approved')",
    [org, users[1]],
  );
  await as(0);
  await assert.rejects(
    cmd("approve", { request_id: r.id }),
    /Approved time off/,
  );
  await db.exec("reset role");
  await db.query(
    "delete from public.time_off_requests where organization_id=$1",
    [org],
  );
  // New overlapping draft work after consent also blocks final approval.
  const conflictId="60000000-0000-0000-0000-000000000004";
  await db.query("insert into public.shifts(id,organization_id,schedule_id,employee_id,starts_at,ends_at)values($1,$2,$3,$4,'2030-01-07T07:00Z','2030-01-07T09:00Z')",[conflictId,org,sid,users[1]]);
  await as(0);await assert.rejects(cmd("approve",{request_id:r.id}),/Overlapping draft/);
  await db.exec("reset role");await db.query("delete from public.shifts where id=$1",[conflictId]);
  // Unrelated unpublished changes remain unpublished after a transfer.
  await db.query(
    "update public.schedules set revision=revision+1 where id=$1",
    [sid],
  );
  await as(0);
  const approvals = await Promise.allSettled([
    cmd("approve", { request_id: r.id }),
    cmd("approve", { request_id: r.id }),
  ]);
  assert.equal(approvals.filter((x) => x.status === "fulfilled").length, 1);
  const draft = await row(
    "select revision,published_revision from public.schedules where id=$1",
    [sid],
  );
  assert.notEqual(draft.revision, draft.published_revision);
  await as(1);
  r = await cmd("coverage", { shift_id: a });
  await as(2);
  r = await cmd("accept", { request_id: r.id });
  await db.exec("reset role");
  await db.query(
    "update public.published_schedules set revision=revision+1 where id=$1",
    [sid],
  );
  await as(0);
  await assert.rejects(
    cmd("approve", { request_id: r.id }),
    /schedule changed/,
  );
  await cmd("deny", { request_id: r.id });
  // Diagnostics do not expose private contact data or another employee's time off.
  await as(1);
  const preview = await row("select public.transfer_preview($1,$2,$3) p", [
    org,
    b,
    users[1],
  ]);
  assert.equal(preview.p.eligible, true);
  assert.equal(typeof preview.p.weekly_hours, "number");
  await assert.rejects(
    row("select public.transfer_preview($1,$2,$3)", [org, b, users[2]]),
    /Permission/,
  );
  await assert.rejects(db.query("select email from public.employees"));
  await assert.rejects(db.query("select * from public.shift_email_deliveries"));
  await assert.rejects(db.query("select public.claim_shift_emails()"));
  // Published unassigned shifts are claimed with explicit employee consent.
  await db.exec("reset role");
  const openId = "60000000-0000-0000-0000-000000000003";
  await db.query("insert into public.shifts(id,organization_id,schedule_id,employee_id,starts_at,ends_at)values($1,$2,$3,null,'2030-01-09T06:00Z','2030-01-09T14:00Z')", [openId,org,sid]);
  await db.query("insert into public.published_shifts(id,organization_id,schedule_id,employee_id,starts_at,ends_at,position_name,notes)values($1,$2,$3,null,'2030-01-09T06:00Z','2030-01-09T14:00Z','General','')", [openId,org,sid]);
  await as(1);r=await cmd("open",{shift_id:openId});assert.equal(r.status,"pending");assert.equal(r.accepted_by,users[1]);
  await as(0);await cmd("approve",{request_id:r.id});
  assert.equal((await row("select employee_id from public.published_shifts where id=$1",[openId])).employee_id,users[1]);
  await db.exec("reset role");assert.ok((await row("select count(*)::integer n from public.shift_email_deliveries")).n>0);
  await as(3);
  assert.equal(
    (await db.query("select * from public.shift_requests")).rows.length,
    0,
  );
  await assert.rejects(cmd("accept", { request_id: r.id }), /Permission/);
  await db.exec("reset role;set role anon");
  await assert.rejects(cmd("coverage", { shift_id: a }));
  await db.close();
});
