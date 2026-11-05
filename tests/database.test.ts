import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { safeNext } from "../lib/forms";

test("redirects stay on the application origin", () => {
  for (const value of [
    "//evil.test",
    "/\\evil.test",
    "https://evil.test",
    "/\n/evil",
    "/\t/evil.test",
    "/ /evil.test",
  ])
    assert.equal(safeNext(value), "/workspaces");
  assert.equal(safeNext("/invite?token=abc"), "/invite?token=abc");
});

test("real Postgres RLS, role permissions and invitation lifecycle", async (t) => {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema public,auth to authenticated,anon;
 grant execute on function auth.uid() to authenticated,anon;`);
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/202611050001_workspaces.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const ids = Array.from(
    { length: 6 },
    (_, i) => `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
  );
  for (let i = 0; i < ids.length; i++)
    await db.query(
      `insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)`,
      [
        ids[i],
        `person${i}@example.test`,
        i === 5 ? null : new Date().toISOString(),
      ],
    );
  async function as(i: number) {
    await db.exec("reset role");
    await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
      ids[i],
    ]);
    await db.exec("set role authenticated");
  }
  async function value(sql: string, args: unknown[] = []) {
    return (await db.query<Record<string, unknown>>(sql, args)).rows[0];
  }
  const digest = (s: string) => createHash("sha256").update(s).digest("hex");
  await as(0);
  const a = (
    await value(
      `select public.create_workspace('Alpha','America/Denver') as id`,
    )
  ).id;
  await as(1);
  const b = (
    await value(`select public.create_workspace('Beta','Europe/London') as id`)
  ).id;
  await t.test("organization data and profiles are isolated", async () => {
    assert.equal(
      (await db.query("select * from public.organizations")).rows.length,
      1,
    );
    assert.equal(
      (await db.query("select * from public.organizations where id=$1", [a]))
        .rows.length,
      0,
    );
    assert.equal(
      (await db.query("select * from public.profiles where id=$1", [ids[0]]))
        .rows.length,
      0,
    );
    assert.equal(
      (
        await db.query(
          `update public.organizations set name='Intrusion' where id=$1 returning id`,
          [a],
        )
      ).rows.length,
      0,
    );
    await assert.rejects(
      db.query(
        `insert into public.positions(organization_id,name) values($1,'Other')`,
        [a],
      ),
    );
    await assert.rejects(
      db.query(
        `select public.invite_employee($1,'person2@example.test','employee',$2)`,
        [a, digest("foreign")],
      ),
    );
  });
  await as(0);
  async function invite(email: string, role = "employee", token = email) {
    return value(`select public.invite_employee($1,$2,$3,$4) as id`, [
      a,
      email,
      role,
      digest(token),
    ]);
  }
  await invite("person2@example.test");
  await t.test(
    "tokens require verified matching email and are single use",
    async () => {
      await as(3);
      await assert.rejects(
        db.query("select public.accept_invitation($1)", [
          digest("person2@example.test"),
        ]),
      );
      await as(2);
      assert.equal(
        (
          await value("select public.accept_invitation($1) as id", [
            digest("person2@example.test"),
          ])
        ).id,
        a,
      );
      await assert.rejects(
        db.query("select public.accept_invitation($1)", [
          digest("person2@example.test"),
        ]),
      );
      await assert.rejects(
        db.query("select public.accept_invitation($1)", [digest("unknown")]),
      );
    },
  );
  await t.test(
    "employees cannot escalate, change settings or invite",
    async () => {
      await assert.rejects(
        db.query(
          `update public.memberships set role='owner' where user_id=$1`,
          [ids[2]],
        ),
      );
      await assert.rejects(
        db.query(`insert into public.memberships values($1,$2,'owner')`, [
          b,
          ids[2],
        ]),
      );
      await assert.rejects(
        db.query(`select public.change_member_role($1,$2,'manager')`, [
          a,
          ids[2],
        ]),
      );
      await assert.rejects(invite("x@example.test"));
      assert.equal(
        (
          await db.query(
            `update public.organizations set name='No' where id=$1 returning id`,
            [a],
          )
        ).rows.length,
        0,
      );
      await assert.rejects(
        db.query(`select token_hash from public.invitations`),
      );
    },
  );
  await as(0);
  await invite("person3@example.test", "manager");
  await as(3);
  await db.query("select public.accept_invitation($1)", [
    digest("person3@example.test"),
  ]);
  await t.test(
    "managers manage positions and employee invitations only",
    async () => {
      await db.query(
        `insert into public.positions(organization_id,name) values($1,'Front desk')`,
        [a],
      );
      await invite("person4@example.test");
      await assert.rejects(invite("other@example.test", "manager"));
      await assert.rejects(invite("other@example.test", "owner"));
      await assert.rejects(
        db.query(`select public.change_member_role($1,$2,'manager')`, [
          a,
          ids[2],
        ]),
      );
    },
  );
  await t.test(
    "owner role controls prohibit self changes and owner assignment",
    async () => {
      await as(0);
      await db.query(`select public.change_member_role($1,$2,'manager')`, [
        a,
        ids[2],
      ]);
      await assert.rejects(
        db.query(`select public.change_member_role($1,$2,'employee')`, [
          a,
          ids[0],
        ]),
      );
      await assert.rejects(
        db.query(`select public.change_member_role($1,$2,'owner')`, [
          a,
          ids[2],
        ]),
      );
    },
  );
  await t.test(
    "expired, revoked and unverified invitations are rejected",
    async () => {
      await as(0);
      const expired = await invite(
        "person4@example.test",
        "employee",
        "expired",
      );
      const revoked = await invite(
        "person4@example.test",
        "employee",
        "revoked",
      );
      await db.query("select public.revoke_invitation($1)", [revoked.id]);
      await invite("person5@example.test");
      await db.exec("reset role");
      await db.query(
        `update public.invitations set expires_at=now()-interval '1 second' where id=$1`,
        [expired.id],
      );
      await as(4);
      for (const token of ["expired", "revoked"])
        await assert.rejects(
          db.query("select public.accept_invitation($1)", [digest(token)]),
        );
      await as(5);
      await assert.rejects(
        db.query("select public.accept_invitation($1)", [
          digest("person5@example.test"),
        ]),
      );
    },
  );
  await t.test(
    "members can join multiple workspaces without role replacement",
    async () => {
      await as(1);
      await db.query(
        `select public.invite_employee($1,'person2@example.test','employee',$2)`,
        [b, digest("second")],
      );
      await as(2);
      await db.query("select public.accept_invitation($1)", [digest("second")]);
      assert.equal(
        (await db.query("select * from public.organizations")).rows.length,
        2,
      );
      await as(0);
      await invite("person2@example.test", "employee", "existing");
      await as(2);
      await db.query("select public.accept_invitation($1)", [
        digest("existing"),
      ]);
      assert.equal(
        (
          await value(
            "select role from public.memberships where organization_id=$1 and user_id=$2",
            [a, ids[2]],
          )
        ).role,
        "manager",
      );
    },
  );
  await t.test(
    "anonymous callers cannot read data or invoke privileged functions",
    async () => {
      await db.exec("reset role; set role anon");
      await assert.rejects(db.query("select * from public.organizations"));
      await assert.rejects(
        db.query(`select public.create_workspace('No','UTC')`),
      );
    },
  );
  await db.close();
});
