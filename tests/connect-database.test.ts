import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { migrationDatabase } from "./support/migration-database";

test("Connect v1: explicit authorization, identity, safe directory, isolation and revocation", async () => {
  const db = await migrationDatabase();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema public,auth to authenticated,anon,service_role;
   grant execute on function auth.uid() to authenticated,anon,service_role;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const f of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(await readFile(new URL(f, dir), "utf8"));
    const users = Array.from({ length: 3 }, () => randomUUID());
    for (const u of users)
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,'synthetic@example.test',now())",
        [u],
      );
    const as = async (u: string) => {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        u,
      ]);
      await db.exec("set role authenticated");
    };
    const row = async (sql: string, args: unknown[] = []) =>
      (await db.query<any>(sql, args)).rows[0];
    await as(users[0]);
    const org = (
      await row(
        "select public.create_workspace('Synthetic Alpha','America/Denver') id",
      )
    ).id;
    await as(users[2]);
    const other = (
      await row(
        "select public.create_workspace('Synthetic Beta','America/Denver') id",
      )
    ).id;
    await db.exec("reset role");
    await db.query(
      "insert into public.memberships values($1,$2,'manager'),($3,$2,'employee')",
      [org, users[1], other],
    );
    const linked = randomUUID(),
      unlinked = randomUUID(),
      archived = randomUUID();
    await db.query(
      "update public.employees set id=$1 where organization_id=$2 and user_id=$3",
      [linked, org, users[1]],
    );
    await db.query(
      "insert into public.employees(organization_id,id,display_name,archived_at) values($1,$2,'Synthetic unlinked',null),($1,$3,'Synthetic archived',now())",
      [org, unlinked, archived],
    );
    const denied = () =>
      assert.rejects(
        db.query("select public.connect_context_v1($1)", [org]),
        /Connect access denied/,
      );
    await as(users[1]);
    await denied(); // manager is not a Connect grant
    await assert.rejects(
      db.query(
        "insert into public.organization_products values($1,'connect','active')",
        [org],
      ),
      /permission denied/,
    );
    await db.exec("reset role");
    await db.query(
      "insert into public.organization_products values($1,'connect','active'),($2,'connect','active')",
      [org, other],
    );
    await db.query(
      "insert into public.product_memberships values($1,$2,'connect','member')",
      [org, users[1]],
    );
    await assert.rejects(
      db.query(
        "insert into public.product_memberships values($1,$2,'connect','owner')",
        [org, users[0]],
      ),
      /check constraint/,
    );
    await assert.rejects(
      db.query(
        "insert into public.product_memberships values($1,$2,'connect','member')",
        [org, users[2]],
      ),
      /foreign key/,
    );
    await assert.rejects(
      db.exec(
        "insert into public.product_releases values ('hospitality',true)",
      ),
      /check constraint/,
    );
    await as(users[1]);
    await denied(); // unavailable release overrides all grants
    await db.exec("reset role");
    await db.exec("update public.product_releases set available=true");
    await as(users[0]);
    await denied(); // owner needs explicit grant too
    await as(users[1]);
    const context = (await row("select public.connect_context_v1($1) c", [org]))
      .c;
    assert.equal(context.account_id, users[1]);
    assert.equal(context.employee_id, linked);
    assert.equal(context.version, "1");
    assert.equal(context.role, "member");
    const entries = (
      await db.query<any>("select * from public.connect_directory_v1($1)", [
        org,
      ])
    ).rows;
    assert.equal(entries.length, 3);
    assert.ok(entries.some((e) => e.employee_id === unlinked));
    assert.ok(!entries.some((e) => e.employee_id === archived));
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), [
        "display_name",
        "employee_id",
        "organization_id",
      ]);
      assert.equal(entry.organization_id, org);
    }
    await assert.rejects(
      db.query("select * from public.connect_directory_v1($1)", [other]),
      /Connect access denied/,
    );
    assert.equal(
      (await db.query("select * from public.product_memberships")).rows.length,
      1,
    );
    for (const sql of [
      "update public.product_memberships set role='moderator'",
      "delete from public.product_memberships",
      "update public.product_releases set available=true",
    ])
      await assert.rejects(db.exec(sql), /permission denied/);
    await db.exec("reset role");
    await db.query(
      "update public.organization_products set state='suspended' where organization_id=$1",
      [org],
    );
    await as(users[1]);
    await denied();
    await db.exec("reset role");
    await db.query(
      "update public.organization_products set state='active' where organization_id=$1",
      [org],
    );
    await db.query(
      "delete from public.product_memberships where organization_id=$1",
      [org],
    );
    await as(users[1]);
    await denied();
    assert.equal(
      (await row("select public.workspace_role_for($1) r", [org])).r,
      "manager",
    ); // Workforce still works
    await db.exec("reset role");
    await db.query(
      "insert into public.product_memberships values($1,$2,'connect','moderator')",
      [org, users[1]],
    );
    await as(users[1]);
    assert.equal((await row("select public.connect_context_v1($1) c", [org])).c.role, "moderator");
    await db.exec("reset role");
    await db.query("update public.employees set user_id=null where organization_id=$1 and id=$2", [org,linked]);
    await as(users[1]);
    assert.equal((await row("select public.connect_context_v1($1) c", [org])).c.employee_id, null);
    await db.exec("reset role");
    await db.query(
      "delete from public.memberships where organization_id=$1 and user_id=$2",
      [org, users[1]],
    );
    assert.equal(
      (await db.query("select * from public.product_memberships")).rows.length,
      0,
    );
    await as(users[1]);
    await denied();
    await db.exec("reset role;set role anon");
    await assert.rejects(
      db.query("select public.connect_context_v1($1)", [org]),
      /permission denied/,
    );
    await assert.rejects(
      db.query("select * from public.product_memberships"),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});
