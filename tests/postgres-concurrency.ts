import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";

test("PostgreSQL multi-session locks serialize cross-week assignment, time off, publication and acceptance", async () => {
  const connectionString = process.env.SHIFTLY_TEST_DATABASE_URL;
  assert.ok(
    connectionString,
    "Set SHIFTLY_TEST_DATABASE_URL to an administrative connection on a disposable local PostgreSQL cluster.",
  );
  const url = new URL(connectionString);
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    "This test only permits a local disposable PostgreSQL cluster.",
  );
  const admin = new Client({ connectionString });
  await admin.connect();
  const database = `shiftly_phase5_${randomUUID().replaceAll("-", "")}`;
  const clients: Client[] = [];
  await admin.query(`create database "${database}"`);
  url.pathname = `/${database}`;
  const connect = async (name: string) => {
    const client = new Client({
      connectionString: url.toString(),
      application_name: name,
    });
    await client.connect();
    clients.push(client);
    return client;
  };
  try {
    const setup = await connect("shiftly-phase5-setup");
    await setup.query(`do $$begin create role anon;exception when duplicate_object then null;end$$;
      do $$begin create role authenticated;exception when duplicate_object then null;end$$;
      create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await setup.query(await readFile(new URL(file, dir), "utf8"));
    const users = Array.from({ length: 4 }, () => randomUUID());
    for (const [i, user] of users.entries())
      await setup.query(
        "insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())",
        [user, `concurrency${i}@example.test`],
      );
    const as = async (client: Client, user: string) => {
      await client.query("reset role");
      await client.query(
        "select set_config('request.jwt.claim.sub',$1,false)",
        [user],
      );
      await client.query("set role authenticated");
    };
    await as(setup, users[0]);
    const org = (
      await setup.query(
        "select public.create_workspace('Synthetic Concurrency Team','America/Denver') id",
      )
    ).rows[0].id;
    await setup.query("reset role");
    for (const user of users.slice(1))
      await setup.query(
        "insert into public.memberships values($1,$2,'employee')",
        [org, user],
      );
    await as(setup, users[0]);
    const command = async (
      client: Client,
      cmd: string,
      payload: object,
      revision: number | null = null,
    ) =>
      (
        await client.query("select public.schedule_command($1,$2,$3,$4) r", [
          org,
          cmd,
          JSON.stringify(payload),
          revision,
        ])
      ).rows[0].r;
    const request = async (client: Client, cmd: string, payload: object) =>
      (
        await client.query("select public.shift_request_command($1,$2,$3) r", [
          org,
          cmd,
          JSON.stringify(payload),
        ])
      ).rows[0].r;
    const off = async (client: Client, cmd: string, payload: object) =>
      (
        await client.query("select public.time_off_command($1,$2,$3) r", [
          org,
          cmd,
          JSON.stringify(payload),
        ])
      ).rows[0].r;
    const revision = async (id: string) =>
      (
        await setup.query("select revision from public.schedules where id=$1", [
          id,
        ])
      ).rows[0].revision;
    const first = await command(setup, "create", { week_start: "2030-01-06" });
    const second = await command(setup, "create", { week_start: "2030-01-13" });
    const shared = await command(
      setup,
      "group_save",
      {
        schedule_id: first.id,
        starts_at: "2030-01-07T14:00Z",
        ends_at: "2030-01-07T22:00Z",
        label: "Shared",
        required_count: 2,
        employee_id: users[1],
      },
      await revision(first.id),
    );
    await command(
      setup,
      "group_assign",
      {
        schedule_id: first.id,
        shift_group_id: shared.id,
        employee_id: users[2],
      },
      await revision(first.id),
    );
    const overnight = await command(
      setup,
      "group_save",
      {
        schedule_id: first.id,
        starts_at: "2030-01-13T06:00Z",
        ends_at: "2030-01-13T14:00Z",
        label: "Overnight",
      },
      await revision(first.id),
    );
    const adjacent = await command(
      setup,
      "group_save",
      {
        schedule_id: second.id,
        starts_at: "2030-01-13T13:00Z",
        ends_at: "2030-01-13T21:00Z",
        label: "Adjacent week",
      },
      await revision(second.id),
    );
    const one = await connect("shiftly-phase5-first");
    const two = await connect("shiftly-phase5-second");
    await as(one, users[0]);
    await as(two, users[0]);
    const outcomes = await Promise.allSettled([
      command(
        one,
        "group_assign",
        {
          schedule_id: first.id,
          shift_group_id: overnight.id,
          employee_id: users[3],
        },
        await revision(first.id),
      ),
      command(
        two,
        "group_assign",
        {
          schedule_id: second.id,
          shift_group_id: adjacent.id,
          employee_id: users[3],
        },
        await revision(second.id),
      ),
    ]);
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.match(
      String(
        (outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult)
          .reason,
      ),
      /overlapping/,
    );
    // Observe actual backend lock waits, rather than relying on timing alone.
    const waitForLock = async () => {
      for (let i = 0; i < 100; i++) {
        const result = await admin.query(
          "select 1 from pg_stat_activity where datname=$1 and application_name='shiftly-phase5-second' and wait_event_type='Lock'",
          [database],
        );
        if (result.rows.length) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(
        "Expected the second PostgreSQL backend to wait for the organization lock",
      );
    };
    // Copy confirmation waits on the same organization lock and rejects stale previews.
    const copy = async (client: Client, token: string | null = null) => (
      await client.query("select public.copy_schedule_week($1,'2030-01-06','2030-02-03','all','merge',$2) r", [org, token])
    ).rows[0].r;
    const copyPreview = await copy(setup);
    await one.query("begin");
    await copy(one, copyPreview.token);
    const competingCopy = copy(two, copyPreview.token);
    const copyFailure = assert.rejects(competingCopy, /Stale revision/);
    await waitForLock();
    await one.query("commit");
    await copyFailure;
    assert.equal((await setup.query("select count(*)::int n from public.schedules where organization_id=$1 and week_start='2030-02-03'", [org])).rows[0].n, 1);
    const affected = (
      await setup.query(
        "select id from public.shifts where shift_group_id=$1 and employee_id=$2",
        [shared.id, users[2]],
      )
    ).rows[0].id;
    await as(setup, users[2]);
    const absence = await off(setup, "submit", {
      employee_id: users[2],
      start_date: "2030-01-07",
      end_date: "2030-01-07",
      full_day: true,
    });
    await as(setup, users[0]);
    await command(
      setup,
      "group_assign",
      {
        schedule_id: first.id,
        shift_group_id: shared.id,
        assignment_id: affected,
        employee_id: "",
      },
      await revision(first.id),
    );
    await one.query("begin");
    await off(one, "approve", { id: absence.id });
    const blockedAssignment = command(
      two,
      "group_assign",
      {
        schedule_id: first.id,
        shift_group_id: shared.id,
        employee_id: users[2],
      },
      await revision(first.id),
    );
    const assignmentResult = blockedAssignment.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitForLock();
    await one.query("commit");
    assert.match(
      String(((await assignmentResult) as { error: unknown }).error),
      /Approved time off/,
    );
    assert.equal(
      (
        await setup.query("select employee_id from public.shifts where id=$1", [
          affected,
        ])
      ).rows[0].employee_id,
      null,
    );
    const beforePublication = await revision(first.id);
    await one.query("begin");
    await command(
      one,
      "publish",
      { schedule_id: first.id, allow_incomplete: true },
      beforePublication,
    );
    const blockedEdit = command(
      two,
      "group_staffing",
      { schedule_id: first.id, shift_group_id: shared.id, required_count: 3 },
      beforePublication,
    );
    const editResult = blockedEdit.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitForLock();
    await one.query("commit");
    assert.ok(((await editResult) as { value: unknown }).value);
    assert.equal(
      (
        await setup.query(
          "select required_count from public.shift_groups where id=$1",
          [shared.id],
        )
      ).rows[0].required_count,
      3,
    );
    assert.equal(
      (
        await setup.query(
          "select distinct required_count from public.published_shifts where shift_group_id=$1",
          [shared.id],
        )
      ).rows[0].required_count,
      2,
    );
    const published = (
      await setup.query(
        "select * from public.published_shifts where shift_group_id=$1 order by id",
        [shared.id],
      )
    ).rows;
    const source = published.find((row) => row.employee_id === users[1]);
    await as(one, users[1]);
    const offer = await request(one, "coverage", { shift_id: source.id });
    await as(one, users[3]);
    await as(two, users[0]);
    const accepts = await Promise.allSettled([
      request(one, "accept", { request_id: offer.id }),
      request(two, "accept", { request_id: offer.id }),
    ]);
    assert.equal(accepts.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal(
      (
        await setup.query(
          "select status from public.shift_requests where id=$1",
          [offer.id],
        )
      ).rows[0].status,
      "pending",
    );
    await request(setup, "approve", { request_id: offer.id });
    const after = (
      await setup.query(
        "select * from public.published_shifts where shift_group_id=$1 order by id",
        [shared.id],
      )
    ).rows;
    assert.notEqual(
      after.find((row) => row.id === source.id).employee_id,
      users[1],
    );
    assert.deepEqual(
      after.filter((row) => row.id !== source.id),
      published.filter((row) => row.id !== source.id),
    );
    // None of the concurrent transfer/publication operations published the private count change.
    assert.equal(
      after.every((row) => row.required_count === 2),
      true,
    );
  } finally {
    for (const client of clients) {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
    await admin.query(`drop database "${database}"`);
    await admin.end();
  }
});
