import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { migrationDatabase } from "./support/migration-database";
import {
  EMPLOYEE_COLORS,
  employeeColor,
  employeeColorStyle,
  isEmployeeColorKey,
} from "../lib/scheduling/employee-colors";

test("employee palette uses constrained keys and readable text on every tint", () => {
  const luminance = (hex: string) => {
    const c = hex
      .slice(1)
      .match(/../g)!
      .map((v) => parseInt(v, 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  };
  const contrast = (a: string, b: string) => {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };
  assert.equal(EMPLOYEE_COLORS.length, 8);
  for (const color of EMPLOYEE_COLORS) {
    assert.ok(isEmployeeColorKey(color.key));
    assert.ok(
      contrast(color.ink, color.tint) >= 4.5,
      `${color.key} text contrast`,
    );
    assert.ok(
      contrast(color.tone, color.tint) >= 3,
      `${color.key} indicator contrast`,
    );
  }
  for (const value of [
    null,
    undefined,
    "invalid",
    "__proto__",
    "red;display:none",
  ]) {
    assert.equal(isEmployeeColorKey(value), false);
    assert.equal(employeeColor(value).key, "sage");
    assert.deepEqual(employeeColorStyle(value), employeeColorStyle("sage"));
  }
});

test("employee colors: upgrade defaults, owner/manager authorization, persistence and workplace isolation", async () => {
  const db = await migrationDatabase();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon,service_role;
      grant execute on function auth.uid() to authenticated,anon,service_role;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const migration = files.find((f) => f.endsWith("_employee_colors.sql"))!;
    for (const file of files.filter((f) => f !== migration))
      await db.exec(await readFile(new URL(file, dir), "utf8"));
    const users = [1, 2, 3, 4].map(
      (i) => `c0000000-0000-0000-0000-00000000000${i}`,
    );
    for (const [i, id] of users.entries())
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [id, `color${i}@example.test`],
      );
    const row = async (sql: string, args: unknown[] = []): Promise<any> =>
      (await db.query(sql, args)).rows[0];
    const as = async (i: number) => {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        users[i],
      ]);
      await db.exec("set role authenticated");
    };
    await as(0);
    const org = (
      await row(
        "select public.create_workspace('Color Alpha','America/Denver') id",
      )
    ).id;
    await as(3);
    const other = (
      await row("select public.create_workspace('Color Beta','UTC') id")
    ).id;
    await db.exec("reset role");
    await db.query(
      "insert into public.memberships values($1,$2,'manager'),($1,$3,'employee'),($4,$3,'employee')",
      [org, users[1], users[2], other],
    );
    await as(0);
    const roster = (
      await row(
        "insert into public.employees(organization_id,display_name) values($1,'Synthetic roster colleague') returning id",
        [org],
      )
    ).id;
    await db.exec("reset role");
    const before = (
      await row(
        "select jsonb_agg(to_jsonb(e) order by id) v from public.employees e where organization_id=$1",
        [org],
      )
    ).v;
    await db.exec("reset role");
    await db.exec(await readFile(new URL(migration, dir), "utf8"));
    const after = (
      await row(
        "select jsonb_agg(to_jsonb(e)-'color_key' order by id) v from public.employees e where organization_id=$1",
        [org],
      )
    ).v;
    assert.deepEqual(after, before);
    await as(0);
    assert.equal(
      (
        await row(
          "select count(*)::int n from public.employees where organization_id=$1 and color_key<>'sage'",
          [org],
        )
      ).n,
      0,
    );
    for (const key of EMPLOYEE_COLORS.map((c) => c.key)) {
      await row(
        "update public.employees set color_key=$1 where organization_id=$2 and id=$3 returning id",
        [key, org, roster],
      );
      assert.equal(
        (
          await row(
            "select color_key from public.employees where organization_id=$1 and id=$2",
            [org, roster],
          )
        ).color_key,
        key,
      );
    }
    const added = await row(
      "insert into public.employees(organization_id,display_name) values($1,'Synthetic new colleague') returning id,color_key",
      [org],
    );
    assert.equal(added.color_key, "sage");
    await as(1);
    await db.query(
      "update public.employees set color_key='blue' where organization_id=$1 and id=$2",
      [org, users[2]],
    );
    await db.query(
      "update public.employees set color_key='blue' where organization_id=$1 and id=$2",
      [org, roster],
    );
    await db.query(
      "update public.employees set display_name='Synthetic edited colleague' where organization_id=$1 and id=$2",
      [org, roster],
    );
    await as(0);
    assert.equal(
      (
        await row(
          "select color_key from public.employees where organization_id=$1 and id=$2",
          [org, roster],
        )
      ).color_key,
      "blue",
    );
    assert.equal(
      (
        await row(
          "select color_key from public.employees where organization_id=$1 and id=$2",
          [org, users[2]],
        )
      ).color_key,
      "blue",
    );
    await as(2);
    assert.equal(
      (
        await db.query(
          "update public.employees set color_key='pink' where organization_id=$1 returning id",
          [org],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await row(
          "select color_key from public.employees where organization_id=$1 and id=$2",
          [org, users[2]],
        )
      ).color_key,
      "blue",
    );
    assert.equal(
      (
        await row(
          "select color_key from public.employees where organization_id=$1 and id=$2",
          [other, users[2]],
        )
      ).color_key,
      "sage",
    );
    await assert.rejects(
      db.query(
        "insert into public.employees(organization_id,display_name,color_key) values($1,'Unauthorized','pink')",
        [org],
      ),
      /row-level security/,
    );
    await as(1);
    assert.equal(
      (
        await db.query(
          "update public.employees set color_key='pink' where organization_id=$1 returning id",
          [other],
        )
      ).rows.length,
      0,
    );
    await assert.rejects(
      db.query(
        "update public.employees set color_key='invalid' where organization_id=$1 and id=$2",
        [org, roster],
      ),
      /employees_color_key_check/,
    );
    await assert.rejects(
      db.query(
        "update public.employees set color_key=null where organization_id=$1 and id=$2",
        [org, roster],
      ),
      /not-null constraint/,
    );
    await assert.rejects(
      db.query(
        "update public.employees set user_id=$1 where organization_id=$2 and id=$3",
        [users[1], org, roster],
      ),
      /permission denied/,
    );
    await as(3);
    await db.query(
      "update public.employees set color_key='pink' where organization_id=$1 and id=$2",
      [other, users[2]],
    );
    await as(2);
    assert.equal(
      (
        await row(
          "select color_key from public.employees where organization_id=$1 and id=$2",
          [other, users[2]],
        )
      ).color_key,
      "pink",
    );
    assert.equal(
      (
        await row(
          "select color_key from public.employees where organization_id=$1 and id=$2",
          [org, users[2]],
        )
      ).color_key,
      "blue",
    );
  } finally {
    await db.close();
  }
});
