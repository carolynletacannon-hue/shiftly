import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";

test("additive roster migration, bulk setup and verified invitation linking", async (t) => {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const migration = files.find((f) => f.includes("simple_weekly"))!;
  for (const f of files.filter((f) => f !== migration))
    await db.exec(await readFile(new URL(f, dir), "utf8"));
  const ids = Array.from(
    { length: 5 },
    (_, i) => `10000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
  );
  for (const [i, id] of ids.entries())
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)",
      [
        id,
        `roster${i}@example.test`,
        i === 3 ? null : new Date().toISOString(),
      ],
    );
  async function as(i: number) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      ids[i],
    ]);
    await db.exec("set role authenticated");
  }
  async function value(sql: string, args: unknown[] = []) {
    return (await db.query<Record<string, any>>(sql, args)).rows[0];
  }
  async function command(
    org: string,
    cmd: string,
    payload: object,
    revision: number | null = null,
  ) {
    return (
      await value("select public.schedule_command($1,$2,$3::jsonb,$4) as r", [
        org,
        cmd,
        JSON.stringify(payload),
        revision,
      ])
    ).r;
  }
  const digest = (s: string) => createHash("sha256").update(s).digest("hex");
  await as(0);
  const org = (
    await value(
      "select public.create_workspace('Migration Hotel','America/Denver') as id",
    )
  ).id;
  const old = await command(org, "create", { week_start: "2026-11-01" });
  const oldShift = await command(
    org,
    "save",
    {
      schedule_id: old.id,
      employee_id: ids[0],
      starts_at: "2026-11-01T14:00:00Z",
      ends_at: "2026-11-01T22:00:00Z",
    },
    1,
  );
  await command(org, "publish", { schedule_id: old.id }, oldShift.revision);
  await db.exec("reset role");
  const before = (await db.query("select * from public.shifts")).rows;
  const publishedBefore = (
    await db.query("select * from public.published_shifts")
  ).rows;
  await db.exec(await readFile(new URL(migration, dir), "utf8"));
  assert.deepEqual(
    (await db.query("select * from public.shifts")).rows,
    before,
  );
  assert.deepEqual(
    (await db.query("select * from public.published_shifts")).rows,
    publishedBefore,
  );
  await as(0);
  let placeholder: string;
  let draft: { id: string; revision: number };
  let assigned: string;
  await t.test(
    "existing membership and assigned ids survive; placeholders get no membership",
    async () => {
      assert.equal(
        (
          await value(
            "select id,user_id from public.employees where organization_id=$1",
            [org],
          )
        ).id,
        ids[0],
      );
      placeholder = (
        await value(
          "insert into public.employees(organization_id,display_name) values($1,'Sample Employee') returning id",
          [org],
        )
      ).id;
      assert.equal(
        (
          await value(
            "select count(*)::int n from public.memberships where organization_id=$1",
            [org],
          )
        ).n,
        1,
      );
      await assert.rejects(
        db.query("update public.employees set user_id=$1 where id=$2", [
          ids[1],
          placeholder,
        ]),
      );
      await assert.rejects(
        db.query("insert into public.memberships values($1,$2,'manager')", [
          org,
          placeholder,
        ]),
      );
    },
  );
  const templates = (
    await db.query<{ id: string }>(
      "select id from public.shift_templates where organization_id=$1 order by start_time",
      [org],
    )
  ).rows;
  const items = templates.map((t) => ({
    template_id: t.id,
    days: [0, 1, 2, 3, 4, 5, 6],
    required_count: 1,
  }));
  await t.test(
    "one save creates 21 rules; new drafts generate 21 slots without changing old weeks",
    async () => {
      await db.query("select public.save_weekly_setup($1,$2,0)", [
        org,
        JSON.stringify(items),
      ]);
      assert.equal(
        (
          await value(
            "select count(*)::int n from public.coverage_requirements where organization_id=$1 and is_active",
            [org],
          )
        ).n,
        21,
      );
      draft = await command(org, "create", { week_start: "2026-11-08" });
      assert.equal(
        (
          await value(
            "select count(*)::int n from public.shifts where schedule_id=$1",
            [draft.id],
          )
        ).n,
        21,
      );
      assert.equal(
        (
          await value(
            "select count(*)::int n from public.shifts where schedule_id=$1",
            [old.id],
          )
        ).n,
        1,
      );
      await assert.rejects(
        command(org, "create", { week_start: "2026-11-08" }),
      );
      await assert.rejects(
        db.query("select public.save_weekly_setup($1,$2,0)", [
          org,
          JSON.stringify(items),
        ]),
      );
      const version = (
        await value(
          "select revision from public.weekly_setup_versions where organization_id=$1",
          [org],
        )
      ).revision;
      await assert.rejects(
        db.query("select public.save_weekly_setup($1,$2,$3)", [
          org,
          JSON.stringify([{ ...items[0], days: [9] }]),
          version,
        ]),
      );
      assert.equal(
        (
          await value(
            "select count(*)::int n from public.coverage_requirements where organization_id=$1 and is_active",
            [org],
          )
        ).n,
        21,
      );
    },
  );
  await t.test(
    "roster only employees schedule, unassign and publish through the existing validation boundary",
    async () => {
      const slots = (
        await db.query<{ id: string }>(
          "select id from public.shifts where schedule_id=$1 order by starts_at",
          [draft.id],
        )
      ).rows;
      assigned = slots[0].id;
      let r = await command(
        org,
        "assign",
        { schedule_id: draft.id, id: assigned, employee_id: placeholder },
        draft.revision,
      );
      draft.revision = r.revision;
      assert.equal(
        (
          await value(
            "select sum(extract(epoch from ends_at-starts_at)/3600)::float h from public.shifts where employee_id=$1",
            [placeholder],
          )
        ).h,
        8,
      );
      await assert.rejects(
        command(org, "publish", { schedule_id: draft.id }, draft.revision),
      );
      await command(
        org,
        "publish",
        { schedule_id: draft.id, allow_incomplete: true },
        draft.revision,
      );
      r = await command(
        org,
        "assign",
        { schedule_id: draft.id, id: assigned, employee_id: "" },
        draft.revision,
      );
      draft.revision = r.revision;
      assert.equal(
        (
          await value(
            "select count(*)::int n from public.shifts where schedule_id=$1",
            [draft.id],
          )
        ).n,
        21,
      );
      assert.equal(
        (
          await value(
            "select employee_id from public.published_shifts where id=$1",
            [assigned],
          )
        ).employee_id,
        placeholder,
      );
      r = await command(
        org,
        "assign",
        { schedule_id: draft.id, id: assigned, employee_id: placeholder },
        draft.revision,
      );
      draft.revision = r.revision;
    },
  );
  await t.test(
    "editing bulk setup supports custom times and counts without rewriting existing slots",
    async () => {
      const version = (
        await value(
          "select revision from public.weekly_setup_versions where organization_id=$1",
          [org],
        )
      ).revision;
      const custom = [
        {
          name: "Late desk",
          start_time: "18:00",
          end_time: "22:00",
          end_next_day: false,
          days: [1, 5],
          required_count: 2,
        },
      ];
      await db.query("select public.save_weekly_setup($1,$2,$3)", [
        org,
        JSON.stringify(custom),
        version,
      ]);
      const next = await command(org, "create", { week_start: "2026-11-15" });
      assert.equal(
        (
          await value(
            "select count(*)::int n from public.shifts where schedule_id=$1",
            [next.id],
          )
        ).n,
        4,
      );
      assert.equal(
        (
          await value(
            "select count(*)::int n from public.shifts where schedule_id=$1",
            [draft.id],
          )
        ).n,
        21,
      );
      assert.equal(
        (
          await value("select employee_id from public.shifts where id=$1", [
            assigned,
          ])
        ).employee_id,
        placeholder,
      );
      const current = (
        await value(
          "select revision from public.weekly_setup_versions where organization_id=$1",
          [org],
        )
      ).revision;
      const rule = await value(
        "select id,revision from public.coverage_requirements where organization_id=$1 and is_active limit 1",
        [org],
      );
      await command(
        org,
        "requirement_save",
        {
          id: rule.id,
          template_id: templates[0].id,
          weekday: 1,
          required_count: 1,
          is_active: true,
        },
        rule.revision,
      );
      await assert.rejects(
        db.query("select public.save_weekly_setup($1,$2,$3)", [
          org,
          JSON.stringify(custom),
          current,
        ]),
      );
    },
  );
  await t.test(
    "verified targeted invitation links the roster identity without losing shifts",
    async () => {
      await db.query(
        "select public.issue_roster_invitation($1,$2,'roster1@example.test',$3)",
        [org, placeholder, digest("target")],
      );
      await as(2);
      await assert.rejects(
        db.query("select public.accept_invitation($1)", [digest("target")]),
      );
      await as(1);
      await db.query("select public.accept_invitation($1)", [digest("target")]);
      assert.equal(
        (
          await value(
            "select user_id from public.employees where organization_id=$1 and id=$2",
            [org, placeholder],
          )
        ).user_id,
        ids[1],
      );
      assert.equal(
        (
          await value(
            "select role from public.memberships where organization_id=$1 and user_id=$2",
            [org, ids[1]],
          )
        ).role,
        "employee",
      );
      assert.equal(
        (
          await value(
            "select employee_id from public.published_shifts where id=$1",
            [assigned],
          )
        ).employee_id,
        placeholder,
      );
      await assert.rejects(
        db.query("select public.accept_invitation($1)", [digest("target")]),
      );
      assert.equal(
        (await db.query("select * from public.shifts")).rows.length,
        0,
      );
      await assert.rejects(
        command(org, "create", { week_start: "2026-11-15" }),
      );
      await assert.rejects(
        db.query("select public.employee_contacts($1)", [org]),
      );
      await as(0);
      const second = (
        await value(
          "insert into public.employees(organization_id,display_name) values($1,'Same Name') returning id",
          [org],
        )
      ).id;
      // Separate email rate bucket; later auth email change still needs verification.
      await db.query(
        "select public.issue_roster_invitation($1,$2,'changed@example.test',$3)",
        [org, second, digest("duplicate")],
      );
      await db.exec("reset role");
      await db.query(
        "update auth.users set email='changed@example.test' where id=$1",
        [ids[1]],
      );
      await as(1);
      await assert.rejects(
        db.query("select public.accept_invitation($1)", [digest("duplicate")]),
      );
      await as(0);
      assert.equal(
        (
          await value(
            "select user_id from public.employees where organization_id=$1 and id=$2",
            [org, second],
          )
        ).user_id,
        null,
      );
    },
  );
  await t.test(
    "unverified identities, foreign tenants and anonymous clients cannot link or schedule",
    async () => {
      const third = (
        await value(
          "insert into public.employees(organization_id,display_name) values($1,'Third Sample') returning id",
          [org],
        )
      ).id;
      await db.query(
        "select public.issue_roster_invitation($1,$2,'roster3@example.test',$3)",
        [org, third, digest("unverified")],
      );
      await as(3);
      await assert.rejects(
        db.query("select public.accept_invitation($1)", [digest("unverified")]),
      );
      await as(4);
      const other = (
        await value(
          "select public.create_workspace('Foreign Hotel','UTC') as id",
        )
      ).id;
      assert.equal(
        (
          await db.query(
            "select id from public.employees where organization_id=$1",
            [org],
          )
        ).rows.length,
        0,
      );
      await assert.rejects(
        db.query("select public.save_weekly_setup($1,$2,0)", [
          org,
          JSON.stringify(items),
        ]),
      );
      await assert.rejects(
        db.query(
          "select public.issue_roster_invitation($1,$2,'roster2@example.test',$3)",
          [other, third, digest("foreign")],
        ),
      );
      await assert.rejects(
        command(
          org,
          "assign",
          { schedule_id: draft.id, id: assigned, employee_id: ids[4] },
          draft.revision,
        ),
      );
      await db.exec("reset role;set role anon");
      await assert.rejects(db.query("select id from public.employees"));
      await assert.rejects(
        db.query("select public.accept_invitation($1)", [digest("unverified")]),
      );
    },
  );
  await db.close();
});
