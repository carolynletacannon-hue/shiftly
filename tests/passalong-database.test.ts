// Embedded PostgreSQL by default; loopback-only native sessions exercise locking.
// Behavioral cases adapted from Connect PR #2 at bf349f3.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { migrationDatabase } from "./support/migration-database";
test("Passalong: full migration chain, permissions and behavior", async () => {
  const db = await migrationDatabase();
  const peers: import("pg").Client[] = [];
  const migrations = new URL("../supabase/migrations/", import.meta.url);
  const query = async (sql: string, args: unknown[] = []) =>
    (await db.query<any>(sql, args)).rows;
  const row = async (sql: string, args: unknown[] = []) =>
    (await query(sql, args))[0];
  const as = async (user: string, client: Pick<typeof db, "query"> = db) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [
      user || "",
    ]);
    await client.query("set role authenticated");
  };
  const rpc = async (
    command: string,
    payload = {},
    org = alpha,
    client: Pick<typeof db, "query"> = db,
  ) =>
    (
      await client.query<any>(
        "select public.connect_passalong_v1($1,$2,$3) result",
        [org, command, payload],
      )
    ).rows[0].result;
  let alpha: string, beta: string;
  try {
    await db.exec(`create role anon;
 create role authenticated;
 create role service_role;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 grant usage on schema public,auth to authenticated,anon,service_role;
 alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
    const files = (await readdir(migrations))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const passalong = files.find((f) =>
      f.endsWith("_phase13c1_passalong.sql"),
    )!;
    assert.ok(passalong, "Workforce owns the versioned Passalong migration");
    for (const file of files.filter((f) => f !== passalong))
      await db.exec(await readFile(new URL(file, migrations), "utf8"));
    const [owner, member, foreign] = Array.from({ length: 3 }, () =>
      randomUUID(),
    );
    for (const user of [owner, member, foreign])
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,'synthetic@example.test',now())",
        [user],
      );
    await as(owner);
    alpha = (
      await row(
        "select public.create_workspace('Synthetic Alpha','America/Denver') id",
      )
    ).id;
    await as(foreign);
    beta = (
      await row(
        "select public.create_workspace('Synthetic Beta','America/Denver') id",
      )
    ).id;
    await db.query("reset role");
    await db.query("insert into public.memberships values($1,$2,'employee')", [
      alpha,
      member,
    ]);
    await db.query(
      "update public.employees set color_key='coral' where organization_id=$1",
      [alpha],
    );
    const baseline = async () => ({
      employees: await query(
        "select * from public.employees order by organization_id,id",
      ),
      functions: await query(
        "select p.oid, n.nspname, p.proname, p.prosecdef, p.proacl, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','shiftly_private') order by p.oid",
      ),
      policies: await query(
        "select * from pg_policies order by schemaname,tablename,policyname",
      ),
      gates: await query(
        "select * from public.product_releases order by product_id",
      ),
    });
    const before = await baseline();
    await db.exec(await readFile(new URL(passalong, migrations), "utf8"));
    const after = await baseline();
    assert.deepEqual(
      {
        ...after,
        functions: after.functions.filter(
          (f) => f.proname !== "connect_passalong_v1",
        ),
      },
      before,
    );
    assert.equal(
      after.employees.find((e) => e.organization_id === alpha).color_key,
      "coral",
    );
    assert.equal(
      (await row("select count(*)::int n from public.organization_products")).n,
      0,
    );
    assert.equal(
      (await row("select count(*)::int n from public.product_memberships")).n,
      0,
    );
    const tables = await query(
      "select relname,relrowsecurity,relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='connect_private' and relkind='r'",
    );
    assert.equal(tables.length, 5);
    assert(tables.every((t) => t.relrowsecurity));
    for (const role of ["anon", "authenticated"]) {
      for (const table of tables) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"])
          assert.equal(
            (
              await row("select has_table_privilege($1,$2,$3) ok", [
                role,
                "connect_private." + table.relname,
                privilege,
              ])
            ).ok,
            false,
          );
      }
      for (const fn of [
        "public.connect_passalong_v1(uuid,text,jsonb)",
        "connect_private.passalong(uuid,text,jsonb)",
      ])
        assert.equal(
          (
            await row("select has_function_privilege($1,$2,'execute') ok", [
              role,
              fn,
            ])
          ).ok,
          role === "authenticated",
        );
    }
    assert.equal(
      (
        await row(
          "select prosecdef from pg_proc where oid='public.connect_passalong_v1(uuid,text,jsonb)'::regprocedure",
        )
      ).prosecdef,
      false,
    );
    assert.deepEqual(
      await query(
        "select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and prosecdef and has_function_privilege('authenticated',p.oid,'execute')",
      ),
      [],
    );
    await as(owner);
    await assert.rejects(
      db.query("select connect_private.passalong($1,'feed','{}')", [alpha]),
      /Connect access denied/,
    );
    await assert.rejects(rpc("feed"), /Connect access denied/); // Workforce owner has no Connect grant
    await db.query("reset role");
    await db.query(
      "insert into public.organization_products values($1,'connect','active'),($2,'connect','active')",
      [alpha, beta],
    );
    await db.query(
      "insert into public.product_memberships values($1,$2,'connect','moderator'),($1,$3,'connect','member'),($4,$5,'connect','member')",
      [alpha, owner, member, beta, foreign],
    );
    await as(member);
    await assert.rejects(rpc("feed"), /Connect access denied/); // release remains off
    await db.query("reset role");
    await db.query(
      "update public.product_releases set available=true where product_id='connect'",
    );
    await as(owner);
    const category = await rpc("category", { name: "Front desk" });
    await rpc("settings", {
      allow_own_edit: true,
      allow_member_resolve: true,
      allow_member_pin: false,
    });
    await assert.rejects(
      rpc("settings", { access_mode: "hybrid" }),
      /not available/,
    );
    await as(member);
    await assert.rejects(
      rpc("category", { name: "Forged" }),
      /manager required/,
    );
    await assert.rejects(
      rpc("settings", { allow_member_pin: true }),
      /manager required/,
    );
    const first = await rpc("create", {
      title: "First shift",
      content: "Synthetic note",
      category_id: category.id,
      actor_account_id: foreign,
      claimed_author_employee_id: randomUUID(),
      created_at: "2000-01-01",
    });
    assert.equal(first.actor_account_id, member);
    assert.equal(first.created_at, first.last_activity_at);
    assert.notEqual(first.created_at, "2000-01-01");
    const employee = (
      await row("select public.connect_context_v1($1) c", [alpha])
    ).c.employee_id;
    assert.equal(first.claimed_author_employee_id, employee);
    const second = await rpc("create", {
      title: "Second shift",
      content: "Other synthetic note",
    });
    assert.equal((await rpc("feed")).notes[0].id, second.id);
    const comment = await rpc("comment", {
      note_id: first.id,
      content: "Synthetic update",
      actor_account_id: foreign,
    });
    assert.equal(comment.actor_account_id, member);
    let bumped = (await rpc("feed")).notes[0];
    assert.equal(bumped.id, first.id);
    assert.equal(bumped.created_at, first.created_at);
    assert.equal(bumped.author_name, first.author_name);
    assert.equal(bumped.comment_count, 1);
    assert.equal(bumped.newest_comment.content, "Synthetic update");
    await rpc("edit", {
      note_id: first.id,
      revision: 1,
      title: "Updated first shift",
      content: "Edited content",
    });
    await assert.rejects(
      rpc("edit", {
        note_id: first.id,
        revision: 1,
        title: "Lost update",
        content: "No",
      }),
      /changed/,
    );
    await rpc("edit_comment", {
      note_id: first.id,
      comment_id: comment.id,
      revision: 1,
      content: "Edited comment",
    });
    await assert.rejects(
      rpc("pin", { note_id: first.id, revision: 2, pinned: true }),
      /not permitted/,
    );
    await as(owner);
    await assert.rejects(
      rpc("edit", {
        note_id: first.id,
        revision: 2,
        title: "Other author",
        content: "No",
      }),
      /not permitted/,
    );
    await rpc("pin", { note_id: second.id, revision: 1, pinned: true });
    assert.equal((await rpc("feed")).notes[0].id, second.id);
    await as(member);
    await rpc("resolve", { note_id: first.id, revision: 2, resolved: true });
    await rpc("comment", { note_id: first.id, content: "Remains resolved" });
    assert(!(await rpc("feed")).notes.some((n: any) => n.id === first.id));
    assert.equal((await rpc("feed", { resolved: true })).notes[0].id, first.id);
    await rpc("resolve", { note_id: first.id, revision: 3, resolved: false });
    await as(owner);
    await rpc("settings", {
      allow_own_edit: false,
      allow_member_resolve: false,
      allow_member_pin: true,
    });
    await as(member);
    await assert.rejects(
      rpc("edit", {
        note_id: first.id,
        revision: 4,
        title: "Blocked",
        content: "No",
      }),
      /not permitted/,
    );
    await assert.rejects(
      rpc("edit_comment", {
        note_id: first.id,
        comment_id: comment.id,
        revision: 2,
        content: "No",
      }),
      /not permitted/,
    );
    await assert.rejects(
      rpc("resolve", { note_id: first.id, revision: 4, resolved: true }),
      /not permitted/,
    );
    await rpc("pin", { note_id: first.id, revision: 4, pinned: true });
    await as(owner);
    await rpc("pin", { note_id: first.id, revision: 5, pinned: false });
    await rpc("settings", {
      allow_own_edit: true,
      allow_member_resolve: true,
      allow_member_pin: false,
    });
    await assert.rejects(
      rpc("edit_comment", {
        note_id: first.id,
        comment_id: comment.id,
        revision: 2,
        content: "Wrong author",
      }),
      /not permitted/,
    );
    await rpc("category", {
      id: category.id,
      name: "Archived synthetic",
      active: false,
    });
    await as(member);
    await assert.rejects(
      rpc("create", {
        title: "Archived",
        content: "No",
        category_id: category.id,
      }),
      /Category unavailable/,
    );
    // Native PostgreSQL exercises row locking through independent authenticated sessions.
    if (db.connectPeer) {
      const comments = await Promise.all(
        Array.from({ length: 6 }, async (_, i) => {
          const peer = await db.connectPeer!();
          peers.push(peer);
          await as(member, peer);
          return rpc(
            "comment",
            { note_id: first.id, content: "Concurrent " + i },
            alpha,
            peer,
          );
        }),
      );
      assert.equal(new Set(comments.map((c) => c.id)).size, 6);
    } else {
      for (let i = 0; i < 6; i++)
        await rpc("comment", { note_id: first.id, content: "Synthetic " + i });
    }
    bumped = (await rpc("feed")).notes.find((n: any) => n.id === first.id);
    assert.equal(bumped.comment_count, 8);
    assert.equal((await rpc("comments", { note_id: first.id })).length, 8);
    assert.equal(
      (await rpc("feed", { search: "Updated first" })).notes.length,
      1,
    );
    assert.equal((await rpc("feed", { author: foreign })).notes.length, 0);
    assert.equal((await rpc("feed", { offset: 25 })).notes.length, 0);
    await assert.rejects(
      rpc("create", { title: "", content: "x" }),
      /constraint/,
    );
    await assert.rejects(
      rpc("comment", { note_id: first.id, content: "x".repeat(4001) }),
      /constraint/,
    );
    await assert.rejects(
      db.query("select * from connect_private.notes"),
      /permission denied/,
    );
    await assert.rejects(
      db.query("update connect_private.history set action='forged'"),
      /permission denied/,
    );
    await as(foreign);
    await assert.rejects(rpc("feed"), /Connect access denied/);
    await assert.rejects(
      rpc("comment", { note_id: first.id, content: "Foreign note" }, beta),
      /unavailable/,
    );
    await assert.rejects(
      rpc(
        "create",
        { title: "Foreign category", content: "No", category_id: category.id },
        beta,
      ),
      /Category unavailable/,
    );
    await as(member);
    await db.query("reset role");
    const historyCount = (
      await row("select count(*)::int n from connect_private.history")
    ).n;
    await as(member);
    await assert.rejects(
      rpc("comment", { note_id: first.id, content: "" }),
      /constraint/,
    );
    await db.exec("reset role");
    assert.equal(
      (await row("select count(*)::int n from connect_private.history")).n,
      historyCount,
    );
    const histories = await query(
      "select * from connect_private.history where action in ('edit','edit_comment')",
    );
    assert.equal(histories.length, 2);
    assert(histories.every((h: any) => h.before_value && h.after_value));
    // Tied timestamps have deterministic UUID secondary ordering.
    await db.query(
      "update connect_private.notes set pinned=false,last_activity_at=$1 where organization_id=$2",
      ["2026-01-01", alpha],
    );
    await as(member);
    const tied = (await rpc("feed")).notes;
    assert.deepEqual(
      tied.map((n: any) => n.id),
      [first.id, second.id].sort().reverse(),
    );
    await db.query("reset role");
    await db.query(
      "delete from public.product_memberships where organization_id=$1 and user_id=$2",
      [alpha, member],
    );
    await as(member);
    for (const command of [
      "feed",
      "comments",
      "create",
      "edit",
      "comment",
      "edit_comment",
      "resolve",
      "pin",
      "settings",
      "category",
    ]) {
      await assert.rejects(
        rpc(command, { note_id: first.id, content: "Denied" }),
        /Connect access denied/,
      );
      await assert.rejects(
        db.query("select connect_private.passalong($1,$2,'{}')", [
          alpha,
          command,
        ]),
        /Connect access denied/,
      );
    }
    assert.equal(
      (await row("select public.workspace_role_for($1) r", [alpha])).r,
      "employee",
    ); // Workforce unaffected
    await db.query("reset role");
    await db.query(
      "insert into public.product_memberships values($1,$2,'connect','member')",
      [alpha, member],
    );
    await db.query(
      "update public.organization_products set state='suspended' where organization_id=$1",
      [alpha],
    );
    await as(member);
    await assert.rejects(rpc("feed"), /Connect access denied/);
    await db.query("reset role");
    await db.query(
      "update public.organization_products set state='active' where organization_id=$1",
      [alpha],
    );
    await db.query(
      "delete from public.memberships where organization_id=$1 and user_id=$2",
      [alpha, member],
    );
    await as(member);
    await assert.rejects(rpc("feed"), /Connect access denied/);
    await as(owner);
    await db.query(
      `select set_config('request.jwt.claims','{"is_anonymous":true}',false)`,
    );
    await assert.rejects(rpc("feed"), /Connect access denied/);
    await db.exec("reset role; set role anon");
    await assert.rejects(rpc("feed"), /permission denied/);
  } finally {
    await Promise.all(peers.map((peer) => peer.end()));
    await db.close();
  }
});
