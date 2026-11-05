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

Auth confirmation and password recovery email delivery remain handled by Supabase. Workspace invitations use Gmail SMTP through Nodemailer when configured (see below). An invite does not provision an Auth user automatically.

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

## Deployment

Shiftly deploys from the `main` branch through Vercel. The deployed site uses Supabase environment variables configured in Vercel, and changes should be reviewed before publishing.


## Automatic workspace invitation emails — dedicated Gmail account

Invitation email delivery uses **Nodemailer and Gmail SMTP**, without a custom
domain or Resend account. Use a dedicated free Gmail account for Shiftly rather
than your personal email. Recipients see `Shiftly <your dedicated Gmail address>`;
Gmail still exposes that sending address, so choose an appropriate account name.
Supabase continues to handle signup confirmation and password recovery separately.

### Gmail and Vercel setup

1. Create or choose your dedicated free Gmail account. Sign in to that account,
   enable **2-Step Verification** in Google Account → Security, then create an
   **App password** for Shiftly at <https://myaccount.google.com/apppasswords>.
   Use this app password, never the account's regular password. If App passwords
   are unavailable, check Google's account eligibility/security settings; do not
   disable TLS or enable obsolete “less secure apps” access.
2. In Vercel → Project → Settings → Environment Variables, configure:

   | Variable | Value |
   | --- | --- |
   | `GMAIL_USER` | The complete dedicated Gmail address, e.g. `your-dedicated-account@gmail.com`. |
   | `GMAIL_APP_PASSWORD` | The Google app password for that same account. Formatting spaces are removed automatically. |
   | `NEXT_PUBLIC_SITE_URL` | Existing setting: canonical HTTPS app origin used by invitation links. Local development may use `http://localhost:3000`. |

   Both Gmail variables are **server-only**. Never prefix them with `NEXT_PUBLIC_`,
   commit them, or paste them into logs. Set them separately for Production and any
   trusted Preview environment that should send real mail. Use controlled recipients
   in previews. Existing `RESEND_API_KEY` and `RESEND_FROM_EMAIL` variables are no
   longer read by this implementation and may be removed.
3. Redeploy through the existing GitHub → Vercel workflow after changing variables.
   The workspace uses the Next.js **Node.js runtime**, which supports Nodemailer.
   SMTP connects to `smtp.gmail.com` on **port 465 with implicit TLS**, requires TLS
   1.2 or newer, and verifies Google's certificate. There is no plaintext fallback.
   Connection/greeting/socket timeouts are bounded; SMTP debugging and logging are
   disabled. No webhook, custom domain, or service-role key is required.
4. Send an invitation to a controlled email address and confirm Gmail acceptance,
   HTML/plain-text content, mobile rendering, and acceptance by the matching
   confirmed account. Verify resend invalidates the previous link. Check Sent/Spam
   and the recipient's inbox if an accepted message does not appear promptly.

**No database change is required for this provider switch.** The invitation email
migration (`20261105025631_invitation_email_delivery.sql`) has already been applied
to this project's Supabase database. **Do not reapply it.** This change neither
modifies migrations nor runs SQL against the hosted project. Automated database
tests create fresh isolated databases; they do not touch Supabase.

### Delivery failures and manual links

Missing or invalid Gmail configuration, or a missing/invalid app origin, preserves
the manual invitation flow. SMTP authentication failures, connection/TLS timeouts,
recipient rejection, and Gmail quotas return a failure result without exposing raw
SMTP errors, credentials, or invitation tokens. The UI only reports acceptance when
Gmail confirms the intended recipient and returns a successful final SMTP response;
this confirms provider acceptance, not inbox delivery.

The latest private link is shown for two minutes and remains usable for seven days
unless accepted or revoked. Copy it to share manually, or use **Resend invitation**
after the cooldown. Resend generates a new token and invalidates the previous link,
even if the new email fails. Accepted and revoked invitations cannot be resent;
expired unused invitations can. A failed or uncertain send is never automatically
retried: SMTP has no API-style idempotency guarantee, and a timeout after acceptance
can leave delivery uncertain. Retrying through resend is an explicit user action.

For authentication errors, check that both variables belong to the dedicated
account, that 2-Step Verification is enabled, and that the app password is current
(it may be revoked after account/security changes). For quota or temporary Gmail
blocks, wait and share the manual link. Free Gmail has daily sending limits and
anti-abuse restrictions that can change; use it for modest invitation volume and
move to a transactional provider if volume grows. Never turn on SMTP debug logs to
troubleshoot production invitations.

### Preserved invitation security and provider extension

Owners may invite employees or managers; managers may invite employees only.
Invitations keep 256-bit tokens, stored SHA-256 digests, seven-day expiry, confirmed
matching-email acceptance, atomic single use, organization isolation, and atomic
resend rotation. The same Postgres limits remain: one invitation per
workspace/recipient per 60 seconds, 20 per actor per rolling hour across workspaces,
and 50 per workspace per rolling hour. Revoked invitations and failed email sends
still count. Rejected rate-limit attempts do not rotate existing tokens.

`lib/email/types.ts` defines the provider-neutral `EmailProvider` contract.
`lib/email/service.ts` selects the provider; `lib/email/gmail.ts` implements Gmail.
A future Resend or transactional provider can implement the same interface and be
selected in the service without changing invitation generation, permissions,
templates, or the database. The delivery key is available for providers that support
idempotency; Gmail does not promise deduplication based on it.

### Validation

Run `npm install`, `npm test`, `npm run typecheck`, and `npm run build` with Node.js
22 or later. Provider tests check TLS/certificate settings, sender/envelope identity,
acceptance/rejection, missing credentials, authentication/timeout failures, cleanup,
provider substitution, and real Nodemailer MIME composition of HTML/plain-text
alternatives. SMTP is mocked, so automated tests send no email. The existing isolated
Postgres tests still cover permissions, organization isolation, expiration, single
use, resend rotation, cooldowns, and actor/workspace limits. After deployment, run
the controlled-recipient smoke test above to verify your actual Gmail account.
