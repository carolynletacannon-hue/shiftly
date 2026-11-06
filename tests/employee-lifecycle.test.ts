import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("employee lifecycle preserves history, blocks unresolved work, revokes only workspace access, and restores safely", async (t) => {
  const db = new PGlite();
  try {
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
      (_, i) => `a0000000-0000-0000-0000-00000000000${i + 1}`,
    );
    for (const [i, user] of users.entries())
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [user, `synthetic${i}@example.test`],
      );
    const row = async (sql: string, args: unknown[] = []): Promise<any> =>
      (await db.query(sql, args)).rows[0];
    async function as(i: number) {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        users[i],
      ]);
      await db.exec("set role authenticated");
    }
    await as(0);
    const org = (
      await row(
        "select public.create_workspace('Lifecycle Test','America/Denver') id",
      )
    ).id;
    await as(3);
    const other = (
      await row(
        "select public.create_workspace('Other Test','America/Denver') id",
      )
    ).id;
    await db.exec("reset role");
    await db.query(
      "insert into public.memberships values($1,$2,'manager'),($1,$3,'employee'),($4,$3,'employee')",
      [org, users[1], users[2], other],
    );
    await as(0);
    const lifecycle = async (
      employee: string,
      command = "inspect",
      workspace = org,
    ) =>
      (
        await row("select public.employee_lifecycle($1,$2,$3) r", [
          workspace,
          employee,
          command,
        ])
      ).r;
    const placeholder = async (name: string) =>
      (
        await row(
          "insert into public.employees(organization_id,display_name) values($1,$2) returning id",
          [org, name],
        )
      ).id;
    const schedule = async (
      command: string,
      payload: object,
      revision: number | null = null,
    ) =>
      (
        await row("select public.schedule_command($1,$2,$3,$4) r", [
          org,
          command,
          JSON.stringify(payload),
          revision,
        ])
      ).r;
    const request = async (command: string, payload: object) =>
      (
        await row("select public.shift_request_command($1,$2,$3) r", [
          org,
          command,
          JSON.stringify(payload),
        ])
      ).r;
    const revision = async (id: string) =>
      (await row("select revision from public.schedules where id=$1", [id]))
        .revision;
    async function add(week: string, employee: string) {
      const draft = await schedule("create", { week_start: week });
      await schedule(
        "group_save",
        {
          schedule_id: draft.id,
          employee_id: employee,
          label: "Synthetic shift",
          starts_at: `${week}T14:00:00Z`,
          ends_at: `${week}T22:00:00Z`,
          required_count: 1,
        },
        await revision(draft.id),
      );
      await schedule(
        "publish",
        { schedule_id: draft.id, allow_incomplete: true },
        await revision(draft.id),
      );
      return {
        draft,
        shift: await row("select * from public.shifts where schedule_id=$1", [
          draft.id,
        ]),
      };
    }
    assert.equal(
      (
        await row(
          "select relrowsecurity from pg_class where oid='public.employee_events'::regclass",
        )
      ).relrowsecurity,
      true,
    );
    assert.equal(
      (
        await row(
          "select has_function_privilege('anon','public.employee_lifecycle(uuid,uuid,text)','execute') allowed",
        )
      ).allowed,
      false,
    );
    assert.equal(
      (
        await row(
          "select has_function_privilege('authenticated','shiftly_private.remove_roster_membership(uuid,uuid)','execute') allowed",
        )
      ).allowed,
      false,
    );
    await t.test(
      "unused placeholder deletion is authorized and dependency-free",
      async () => {
        const unused = await placeholder("Unused placeholder");
        assert.deepEqual((await lifecycle(unused)).delete_reasons, []);
        await as(2);
        await assert.rejects(lifecycle(unused, "archive"), /Permission denied/);
        await assert.rejects(lifecycle(unused, "delete"), /Permission denied/);
        await as(3);
        await assert.rejects(lifecycle(unused, "archive"), /Permission denied/);
        await as(0);
        assert.equal((await lifecycle(unused, "delete")).ok, true);
        assert.equal(
          await row("select id from public.employees where id=$1", [unused]),
          undefined,
        );
        assert.equal((await lifecycle(users[0], "archive")).ok, false);
        await assert.rejects(
          db.query(
            "update public.employees set archived_at=now() where id=$1",
            [users[2]],
          ),
          /permission denied/,
        );
      },
    );
    const past = await add("2020-01-05", users[2]);
    const future = await add("2099-01-04", users[2]);
    await schedule(
      "group_save",
      {
        schedule_id: future.draft.id,
        employee_id: users[1],
        label: "Coworker shift",
        starts_at: "2099-01-05T14:00:00Z",
        ends_at: "2099-01-05T22:00:00Z",
      },
      await revision(future.draft.id),
    );
    await schedule(
      "publish",
      { schedule_id: future.draft.id, allow_incomplete: true },
      await revision(future.draft.id),
    );
    const coworker = await row(
      "select id from public.published_shifts where schedule_id=$1 and employee_id=$2",
      [future.draft.id, users[1]],
    );
    await as(2);
    const pending = await request("swap", {
      shift_id: future.shift.id,
      other_shift_id: coworker.id,
    });
    await as(1);
    assert.equal(
      (await request("accept", { request_id: pending.id })).status,
      "pending",
    );
    await as(0);
    await t.test(
      "future draft/publication and pending requests block archiving without changing coverage",
      async () => {
        const before = (
          await db.query(
            "select * from public.published_shifts where organization_id=$1 order by id",
            [org],
          )
        ).rows;
        const result = await lifecycle(users[2], "archive");
        assert.equal(result.ok, false);
        for (const kind of ["draft", "published", "request"])
          assert.ok(result.blockers.some((b: any) => b.kind === kind));
        assert.deepEqual(
          (
            await db.query(
              "select * from public.published_shifts where organization_id=$1 order by id",
              [org],
            )
          ).rows,
          before,
        );
        assert.equal(
          (
            await row(
              "select role from public.memberships where organization_id=$1 and user_id=$2",
              [org, users[2]],
            )
          ).role,
          "employee",
        );
        await request("deny", { request_id: pending.id });
        await schedule(
          "group_assign",
          {
            schedule_id: future.draft.id,
            shift_group_id: future.shift.shift_group_id,
            assignment_id: future.shift.id,
            employee_id: users[1],
          },
          await revision(future.draft.id),
        );
        await schedule(
          "publish",
          { schedule_id: future.draft.id, allow_incomplete: true },
          await revision(future.draft.id),
        );
      },
    );
    await t.test(
      "pending time off must be reviewed and its notifications survive archival",
      async () => {
        await as(2);
        const off = (
          await row("select public.time_off_command($1,$2,$3) r", [
            org,
            "submit",
            JSON.stringify({
              employee_id: users[2],
              start_date: "2099-02-01",
              end_date: "2099-02-01",
              full_day: true,
            }),
          ])
        ).r;
        await as(0);
        const blocked = await lifecycle(users[2], "archive");
        assert.equal(blocked.ok, false);
        assert.ok(blocked.blockers.some((b: any) => b.kind === "time-off"));
        await row("select public.time_off_command($1,$2,$3)", [
          org,
          "deny",
          JSON.stringify({ id: off.id }),
        ]);
        assert.equal((await lifecycle(users[2])).blockers.length, 0);
        assert.ok(
          (await lifecycle(users[2])).delete_reasons.some((r: string) =>
            r.includes("Time-off records"),
          ),
        );
      },
    );
    await t.test(
      "linked account archive preserves history and removes only this organization membership",
      async () => {
        const history = await row(
          "select * from public.published_shifts where id=$1",
          [past.shift.id],
        );
        await as(1); // managers may archive roster employees
        assert.equal((await lifecycle(users[2], "archive")).ok, true);
        assert.deepEqual(
          await row("select * from public.published_shifts where id=$1", [
            past.shift.id,
          ]),
          history,
        );
        assert.equal(
          (
            await row(
              "select count(*)::int n from public.time_off_requests where organization_id=$1 and employee_id=$2",
              [org, users[2]],
            )
          ).n,
          1,
        );
        assert.equal((await lifecycle(users[2], "delete")).ok, false);
        // Republishing a historical week retains the archived published identity.
        await as(0);
        await schedule(
          "group_save",
          {
            schedule_id: past.draft.id,
            shift_group_id: past.shift.shift_group_id,
            label: "Historical shift",
            starts_at: "2020-01-05T14:00:00Z",
            ends_at: "2020-01-05T22:00:00Z",
            notes: "Reviewed",
          },
          await revision(past.draft.id),
        );
        await schedule(
          "publish",
          { schedule_id: past.draft.id, allow_incomplete: true },
          await revision(past.draft.id),
        );
        assert.equal(
          (
            await row(
              "select employee_id from public.published_shifts where id=$1",
              [past.shift.id],
            )
          ).employee_id,
          users[2],
        );
        // Moving an existing archived assignment to a future date cannot bypass the guard.
        await assert.rejects(
          schedule(
            "group_save",
            {
              schedule_id: past.draft.id,
              shift_group_id: past.shift.shift_group_id,
              label: "Moved",
              starts_at: "2099-01-04T14:00:00Z",
              ends_at: "2099-01-04T22:00:00Z",
            },
            await revision(past.draft.id),
          ),
          /Archived employees/,
        );
        await as(2);
        assert.equal(
          (await row("select public.workspace_role_for($1) role", [org])).role,
          null,
        );
        assert.equal(
          (
            await db.query(
              "select * from public.published_shifts where organization_id=$1",
              [org],
            )
          ).rows.length,
          0,
        );
        assert.equal(
          (await row("select public.workspace_role_for($1) role", [other]))
            .role,
          "employee",
        );
        await assert.rejects(
          request("accept", { request_id: pending.id }),
          /Permission denied/,
        );
        await assert.rejects(
          lifecycle(users[2], "restore"),
          /Permission denied/,
        );
        await db.exec("reset role");
        assert.ok(
          await row("select id from auth.users where id=$1", [users[2]]),
        );
        await as(0);
        await assert.rejects(
          schedule(
            "group_assign",
            {
              schedule_id: future.draft.id,
              shift_group_id: future.shift.shift_group_id,
              employee_id: users[2],
            },
            await revision(future.draft.id),
          ),
          /Archived employees/,
        );
        assert.equal((await lifecycle(users[2], "restore")).ok, true);
        assert.equal(
          (
            await row(
              "select user_id,archived_at from public.employees where id=$1",
              [users[2]],
            )
          ).user_id,
          null,
        );
        await as(2);
        assert.equal(
          (await row("select public.workspace_role_for($1) role", [org])).role,
          null,
        );
        await as(0);
        // Explicit authorized reconnection reuses the original roster identity.
        await row(
          "select public.issue_roster_invitation($1,$2,'synthetic2@example.test',$3)",
          [org, users[2], "a".repeat(64)],
        );
        await as(2);
        await row("select public.accept_invitation($1)", ["a".repeat(64)]);
        assert.equal(
          (await row("select public.workspace_role_for($1) role", [org])).role,
          "employee",
        );
        await as(0);
      },
    );
    await t.test(
      "outstanding roster invitations are revoked; restoration does not reactivate them",
      async () => {
        const invited = await placeholder("Invited placeholder");
        await row(
          "select public.issue_roster_invitation($1,$2,'synthetic3@example.test',$3)",
          [org, invited, "b".repeat(64)],
        );
        assert.equal((await lifecycle(invited, "archive")).ok, true);
        assert.ok(
          (
            await row(
              "select revoked_at from public.invitations where employee_id=$1",
              [invited],
            )
          ).revoked_at,
        );
        await assert.rejects(
          row(
            "select public.issue_roster_invitation($1,$2,'new@example.test',$3)",
            [org, invited, "c".repeat(64)],
          ),
          /Restore this employee/,
        );
        await as(3);
        await assert.rejects(
          row("select public.accept_invitation($1)", ["b".repeat(64)]),
          /invalid or expired/,
        );
        await as(0);
        await lifecycle(invited, "restore");
        await as(3);
        await assert.rejects(
          row("select public.accept_invitation($1)", ["b".repeat(64)]),
          /invalid or expired/,
        );
        await as(0);
      },
    );
    await t.test(
      "permanent deletion rejects audit and new cascade dependencies before deleting anything",
      async () => {
        const unused = await placeholder("Dependent placeholder");
        await db.exec("reset role");
        await db.exec(
          "create table public.future_dependency(organization_id uuid,employee_id uuid,foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete cascade)",
        );
        await db.query("insert into public.future_dependency values($1,$2)", [
          org,
          unused,
        ]);
        await as(0);
        assert.equal((await lifecycle(unused, "delete")).ok, false);
        await db.exec("reset role");
        assert.equal(
          (await db.query("select * from public.future_dependency")).rows
            .length,
          1,
        );
        await as(0);
        assert.ok(
          (await lifecycle(users[2])).delete_reasons.some((reason: string) =>
            reason.includes("audit"),
          ),
        );
        await db.exec("reset role;set role anon");
        await assert.rejects(lifecycle(unused), /permission denied/);
      },
    );
    await t.test(
      "managers cannot remove owners; self-archiving an owner requires another owner",
      async () => {
        await db.exec("reset role");
        await db.query("insert into public.memberships values($1,$2,'owner')", [
          org,
          users[3],
        ]);
        await as(1);
        assert.equal((await lifecycle(users[3], "archive")).ok, false);
        await as(3);
        assert.equal((await lifecycle(users[3], "archive")).ok, true);
        assert.equal(
          (await row("select public.workspace_role_for($1) role", [org])).role,
          null,
        );
        assert.equal(
          (await row("select public.workspace_role_for($1) role", [other]))
            .role,
          "owner",
        );
        await as(0);
        assert.equal((await lifecycle(users[0], "archive")).ok, false);
      },
    );
  } finally {
    await db.close();
  }
});
