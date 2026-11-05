# Shiftly

A mobile-first scheduling product for small teams. Phase 1 provides Supabase email/password authentication and multiple business workspaces. The original dashboard remains at `/demo`: its fictional schedules, time-off requests and approvals are local demonstrations only. No scheduling or time-off tables exist yet.

## Deploy with GitHub and Vercel

1. Apply the migration below to your Supabase project **before using the new screens**.
2. In Vercel → Project → Settings → Environment Variables, configure:
   - `NEXT_PUBLIC_SUPABASE_URL`: your project's URL (already configured).
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: your project's publishable key (already configured).
   - `NEXT_PUBLIC_SITE_URL`: your canonical app origin, such as `https://your-app.vercel.app` (no trailing path). Set this separately for each deployment environment that should receive auth links.
3. Complete the Supabase Auth configuration below, then redeploy. Vercel uses the standard Next.js build; no custom server is needed.

Never commit credentials, `.env.local`, database passwords, service-role keys or access tokens. This app uses the user's session and publishable key; it does not require a service-role key.

## Apply database migrations

The versioned schema is in `supabase/migrations/202611050001_workspaces.sql`. On an existing Supabase project with no Shiftly schema, the simplest hosted setup is to open Supabase → SQL Editor, paste the entire migration, and run it once. Keep a record of the applied version. Do not rerun this initial migration; future changes should be new migration files. Do not apply it over an existing conflicting schema without reviewing the differences.

For a CLI-managed project, use Supabase CLI from a trusted development environment:

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Choose either SQL Editor tracking or CLI migration tracking consistently. If you applied the SQL manually and later adopt the CLI, mark that version applied with `supabase migration repair 202611050001 --status applied` after verifying it matches the project schema. Never paste database credentials into source control.

The migration creates profiles, organizations, memberships, positions, invitations, RLS policies and narrowly granted RPC functions. Existing Auth users receive profiles, and new users receive one through a trigger. Organization creation atomically creates an owner membership. IANA timezones are validated against Postgres timezone names. Settings currently include the start day of the week.

## Supabase Auth dashboard configuration

In Supabase → Authentication:

1. Enable the **Email** provider and email/password signup. Keep **Confirm email enabled**; invitation acceptance requires a confirmed email.
2. Under **URL Configuration**, set **Site URL** to the same canonical origin as `NEXT_PUBLIC_SITE_URL`.
3. Add these **Redirect URLs**, substituting your actual production domain:
   - `https://your-app.vercel.app/auth/callback**`
   - `http://localhost:3000/auth/callback**` if local development is needed.
   The trailing `**` allows the callback's `next` query parameter for onboarding, invitation acceptance and password recovery. Use explicit trusted origins. For previews, add only trusted preview origins and set their `NEXT_PUBLIC_SITE_URL` accordingly; avoid allowing every Vercel deployment globally.
4. Keep signup confirmation and password recovery email templates using Supabase's `{{ .ConfirmationURL }}` link. The app uses PKCE and exchanges its code at `/auth/callback`; links should be opened in the browser where signup/reset began.
5. Configure production SMTP and appropriate email rate limits before inviting real employees. Use Supabase Auth's password controls (minimum 12 characters recommended), rate limits and abuse protections. The app enforces a 12-character minimum on signup/password changes.

Auth email delivery is handled by Supabase. Workspace invitations currently generate a link for an owner/manager to copy and share themselves; **Shiftly does not send invitation emails**. An invite does not provision an Auth user automatically.

## Workspace permissions

| Action | Owner | Manager | Employee |
| --- | --- | --- | --- |
| Read own workspace, roster, positions | Yes | Yes | Yes |
| Change business name/timezone/settings | Yes | No | No |
| Manage positions through RLS-protected API | Yes | Yes | No |
| Invite employees / revoke invitations | Yes | Yes | No |
| Invite managers / change employee-manager roles | Yes | No | No |
| Assign owner or change own role | No | No | No |

Any signed-in user can create another workspace and becomes its owner. A workspace switch is checked against the authenticated user's membership on the server; the remembered workspace cookie never grants access. Direct membership writes are denied. Owner transfer/deletion and member removal are outside this phase. The positions table/API is ready; the current screen lists positions only.

Invitation tokens contain 256 random bits. Only SHA-256 digests are stored in the database, with seven-day expiration, revocation and atomic single-use acceptance. The recipient must sign in with the matching confirmed email. An existing member's role is never overwritten by an invite. Raw tokens are displayed briefly using a two-minute HttpOnly cookie and should be shared privately. Pages set a no-referrer policy; do not add analytics that capture invitation URLs. No invitation credentials are logged by application code.

## Development and validation

Copy `.env.example` to `.env.local` and fill in the public configuration. Use Node.js 22 or later.

```sh
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

`npm test` applies the actual migration to an isolated PGlite Postgres database. A minimal Auth schema simulates verified identities; the tests exercise RLS as `authenticated`/`anon`, cross-organization reads/writes, role escalation attempts, owner/manager/employee permissions, invitation email checks, expiry, revocation, reuse, and membership in multiple workplaces. Tests require no production credentials. CI also runs tests, TypeScript and the production build.

Before production rollout, smoke-test the real hosted Auth integration: sign up and confirm email, sign in/out, request a password reset and follow its link, create two workspaces, switch between them, invite a second confirmed account, accept once and verify a second attempt fails. Confirm an unrelated account cannot open a workspace URL. These email-delivery checks require the configured Supabase project; the local database tests do not simulate Supabase's email service.
