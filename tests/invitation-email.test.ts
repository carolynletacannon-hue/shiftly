import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type EmailMessage } from "../lib/email/service";
import { invitationEmail } from "../lib/email/invitation";
import { issueInvitation, invitationUrl } from "../lib/invitations";

const message = { to: "teammate@example.test", ...invitationEmail({
  businessName: 'Sample <Team> & "Co"', role: "employee", invitationUrl: "https://example.test/invite?token=fixture",
}) };

test("branded HTML escapes untrusted text and includes a plain-text invitation", () => {
  assert.match(message.html, /Sample &lt;Team&gt; &amp; &quot;Co&quot;/);
  assert.doesNotMatch(message.html, /<Team>/);
  for (const body of [message.text, message.html]) {
    assert.match(body, /Join Workspace/);
    assert.match(body, /seven days/);
    assert.match(body, /Create an account or sign in/);
  }
  assert.equal(invitationUrl("fixture", "https://example.test/path"), "https://example.test/invite?token=fixture");
  for (const url of ["", "garbage", "javascript:alert(1)", "http://example.test", "https://user:password@example.test"])
    assert.equal(invitationUrl("fixture", url), null);
});

test("invitation delivery, resend, isolation and persistent limits on actual Postgres", async t => {
  const db = new PGlite();
  const ids = [1, 2, 3, 4].map(i => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
  const digest = (token: string) => createHash("sha256").update(token).digest("hex");
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;`);
  const directory = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter(f => f.endsWith(".sql")).sort())
    await db.exec(await readFile(new URL(file, directory), "utf8"));
  for (const [index, id] of ids.entries())
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [id, `person${index}@example.test`]);
  async function as(index: number) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ids[index]]);
    await db.exec("set role authenticated");
  }
  async function scalar(sql: string, args: unknown[] = []) {
    return (await db.query<{ id: string }>(sql, args)).rows[0].id;
  }
  await as(0);
  const org = await scalar("select public.create_workspace('Sample Team','UTC') as id");
  await as(3);
  const otherOrg = await scalar("select public.create_workspace('Another Team','UTC') as id");
  await as(0);
  // Adapter runs the application's orchestration against real RLS and RPC functions.
  const client = {
    from: () => ({ select: () => ({ eq: (_key: string, id: string) => ({ single: async () => {
      const data = (await db.query("select name from public.organizations where id=$1", [id])).rows[0];
      return { data, error: null };
    } }) }) }),
    rpc: async (_name: string, args: Record<string, unknown>) => {
      try {
        return { data: await scalar("select public.issue_invitation($1,$2,$3,$4,$5) as id", [
          args.org, args.invite_email, args.invite_role, args.token_digest, args.replaces,
        ]), error: null };
      } catch (error) { return { data: null, error: error as Error }; }
    },
  } as unknown as SupabaseClient;
  const input = { organizationId: org, email: "person1@example.test", role: "employee" };
  const previousSite = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.test";
  let delivered: EmailMessage | undefined;
  try {
    await t.test("successful delivery uses the real secure link and normalized address", async () => {
      const issued = await issueInvitation(client, { ...input, email: " Person1@Example.Test " }, async msg => {
        delivered = msg; return { status: "accepted" };
      });
      assert.equal(issued.delivery, "accepted");
      assert.equal(issued.token.length, 64);
      assert.equal(delivered?.to, input.email);
      assert.match(delivered!.text, new RegExp(issued.token));
      await as(1);
      assert.equal(await scalar("select public.accept_invitation($1) as id", [digest(issued.token)]), org);
      await assert.rejects(db.query("select public.accept_invitation($1)", [digest(issued.token)]));
      await as(0);
    });
    await t.test("failed delivery retains a usable matching-email, single-use link", async () => {
      const issued = await issueInvitation(client, { ...input, email: "person2@example.test" }, async () => ({ status: "failed" }));
      assert.equal(issued.delivery, "failed");
      await as(1);
      await assert.rejects(db.query("select public.accept_invitation($1)", [digest(issued.token)]));
      await as(2);
      assert.equal(await scalar("select public.accept_invitation($1) as id", [digest(issued.token)]), org);
      await as(0);
    });
    await t.test("employees and foreign owners cannot send or resend; provider is not called", async () => {
      let called = false;
      for (const index of [1, 3]) {
        await as(index);
        await assert.rejects(issueInvitation(client, { ...input, email: "denied@example.test" }, async () => { called = true; return { status: "accepted" }; }));
        await assert.rejects(db.query("select public.issue_invitation($1,$2,'employee',$3,null)", [org, "denied@example.test", digest("denied")]));
      }
      assert.equal(called, false);
      await as(0);
    });
    await t.test("resend rotates the token atomically; cooldown and role checks preserve old links", async () => {
      const original = await issueInvitation(client, { ...input, email: "retry@example.test" }, async () => ({ status: "unconfigured" }));
      let calls = 0;
      await assert.rejects(issueInvitation(client, { ...input, email: "retry@example.test", replaces: original.invitationId }, async () => { calls++; return { status: "accepted" }; }), /rate-limit/);
      assert.equal(calls, 0);
      await db.exec("reset role");
      await db.query("update public.invitations set created_at=now()-interval '2 minutes' where id=$1", [original.invitationId]);
      await as(0);
      const fresh = await issueInvitation(client, { ...input, email: "retry@example.test", replaces: original.invitationId }, async () => { throw Error("network"); });
      assert.equal(fresh.delivery, "failed");
      assert.notEqual(fresh.token, original.token);
      const rows = (await db.query<{ id: string; revoked_at: string | null; expires_at: string }>("select id,revoked_at,expires_at from public.invitations where id in ($1,$2)", [original.invitationId, fresh.invitationId])).rows;
      assert.ok(rows.find(r => r.id === original.invitationId)?.revoked_at);
      assert.ok(new Date(String(rows.find(r => r.id === fresh.invitationId)?.expires_at)).getTime() > Date.now() + 6 * 86400000);
      await assert.rejects(issueInvitation(client, { ...input, email: "different@example.test", replaces: fresh.invitationId }));
      await assert.rejects(issueInvitation(client, { organizationId: otherOrg, email: "retry@example.test", role: "employee", replaces: fresh.invitationId }));
      await as(1);
      await assert.rejects(db.query("select public.accept_invitation($1)", [digest(original.token)]));
      await as(0);
      // Give the fixture recipient a confirmed identity and verify the replacement works.
      await db.exec("reset role");
      await db.query("update auth.users set email='retry@example.test' where id=$1", [ids[1]]);
      await as(1);
      assert.equal(await scalar("select public.accept_invitation($1) as id", [digest(fresh.token)]), org);
      await as(0);
      await assert.rejects(issueInvitation(client, { ...input, email: "retry@example.test", replaces: fresh.invitationId }));
    });
    await t.test("manager cannot create or resend a manager invitation", async () => {
      await db.exec("reset role");
      await db.query("update public.memberships set role='manager' where organization_id=$1 and user_id=$2", [org, ids[1]]);
      await as(0);
      const high = await issueInvitation(client, { ...input, email: "manager@example.test", role: "manager" }, async () => ({ status: "unconfigured" }));
      await as(1);
      for (const role of ["manager", "owner"])
        await assert.rejects(issueInvitation(client, { ...input, email: "escalate@example.test", role }));
      await assert.rejects(issueInvitation(client, { ...input, email: "manager@example.test", role: "manager", replaces: high.invitationId }));
      await assert.rejects(issueInvitation(client, { ...input, email: "manager@example.test" }));
      await as(0);
    });
    await t.test("expired invitations get fresh expiry; revoked invitations cannot be resent", async () => {
      const old = await issueInvitation(client, { ...input, email: "expired@example.test" }, async () => ({ status: "unconfigured" }));
      await db.exec("reset role");
      await db.query("update public.invitations set created_at=now()-interval '8 days', expires_at=now()-interval '1 day' where id=$1", [old.invitationId]);
      await as(0);
      const fresh = await issueInvitation(client, { ...input, email: "expired@example.test", replaces: old.invitationId }, async () => ({ status: "accepted" }));
      assert.notEqual(fresh.token, old.token);
      await db.query("select public.revoke_invitation($1)", [fresh.invitationId]);
      await assert.rejects(issueInvitation(client, { ...input, email: "expired@example.test", replaces: fresh.invitationId }));
    });
    await t.test("hourly actor limit also applies to the legacy RPC and survives revocation", async () => {
      await db.exec("reset role");
      await db.query("update public.invitations set created_at=now()-interval '2 hours' where created_by=$1", [ids[0]]);
      await as(0);
      for (let i = 0; i < 20; i++) {
        const id = await scalar("select public.invite_employee($1,$2,'employee',$3) as id", [org, `limit${i}@example.test`, digest(`limit${i}`)]);
        await db.query("select public.revoke_invitation($1)", [id]);
      }
      await assert.rejects(db.query("select public.invite_employee($1,'overflow@example.test','employee',$2)", [org, digest("overflow")]), /Invitation rate limit exceeded/);
    });
    await t.test("workspace hourly cap applies independently of the actor cap", async () => {
      await db.exec("reset role");
      // Fixture historical sends belong to a different actor, so only the workspace limit applies.
      await db.query(`insert into public.invitations(organization_id,email,role,token_hash,created_by)
        select $1, 'orgcap'||n||'@example.test', 'employee', lpad(n::text,64,'0'), $2
        from generate_series(1,50) n`, [otherOrg, ids[2]]);
      await as(3);
      await assert.rejects(db.query("select public.issue_invitation($1,'cap@example.test','employee',$2,null)", [otherOrg, digest("orgcap")]), /Invitation rate limit exceeded/);
    });
    await t.test("anonymous callers cannot invoke issuance", async () => {
      await db.exec("reset role; set role anon");
      await assert.rejects(db.query("select public.issue_invitation($1,'anon@example.test','employee',$2,null)", [org, digest("anon")]));
    });
  } finally {
    if (previousSite === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previousSite;
    await db.close();
  }
});
