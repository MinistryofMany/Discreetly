# Web login session model

This documents how the `apps/web` relying party manages a user's login session,
how it forwards the Minister id_token to `services/api`, and a known limitation
in that forwarding path. It covers the web app only. The API auth model is
unchanged and is described at the end for context.

## Database-strategy Auth.js sessions

The web app uses Auth.js v5 (next-auth beta) with the **database session
strategy** backed by a Prisma adapter (`@auth/prisma-adapter`) against the same
Postgres the API uses.

What this means concretely:

- The browser session cookie holds only an opaque session id (`sessionToken`).
  It is not a signed token that carries identity claims. There is nothing in the
  cookie to decode or tamper with beyond the random id.
- Server-side state lives in three Auth.js tables in Postgres: `Session` (one row
  per active login, with `sessionToken`, `userId`, `expires`), `Account` (the
  Minister OAuth account, including the stored `id_token`), and `User` (the local
  user record the adapter creates at first sign-in). These are defined in
  `packages/db/prisma/schema.prisma` and created by the
  `20260617175557_authjs_db_sessions` migration. They are unrelated to the
  pre-existing `AdminUser` model, which is keyed on the Minister pairwise sub and
  governs API-side admin authorization.
- Session lifetime (`maxAge`) is 30 days, which matches the Auth.js default that
  the previous JWT-strategy configuration used. Login lifetime is unchanged by
  this migration.

### Server-side logout revocation

Because the session is a database row rather than a self-contained cookie,
signing out **revokes** the session instead of merely clearing a cookie. When the
app calls `signOut()` (from `next-auth/react`, used by the header and the auth
buttons), Auth.js core, under the database strategy, calls
`adapter.deleteSession(sessionToken)` and deletes the `Session` row. After that
the session id in any still-present cookie refers to nothing and is rejected. The
app has no custom sign-out handler, so this happens through the standard Auth.js
sign-out action with no extra wiring.

This is the main security reason for the migration away from JWT-as-session: a
JWT session cookie remains valid until it expires and cannot be revoked
server-side, whereas a database session can be deleted on demand.

### Display claims

The UI still renders the signed-in user (and previews badge VC JWTs) from the
Minister id_token. Under the database strategy the `session` callback receives the
adapter `user` rather than a JWT token, so it reads the stored id_token back from
the `Account` row, exposes it on `session.idToken`, and decodes the id_token
payload to populate `session.sub`, `session.name`, `session.picture`, and
`session.ministerBadges` (see `apps/web/src/lib/minister-claims.ts`). This decode
does **not** verify the token. It is for display only. A malformed token degrades
to empty display values rather than throwing. The API remains the sole
verification authority for anything the id_token asserts.

## Forwarding the Minister id_token to the API

The web app and the API are decoupled: the API is stateless and verifies the
Minister id_token as a bearer token on each gated call. The web client reads
`session.idToken` and attaches it as `Authorization: Bearer <id_token>` on tRPC
HTTP calls, and passes it as an input parameter on WebSocket subscriptions. This
path is unchanged by the session-strategy migration. The id_token now lives in the
`Account` row instead of inside the session cookie, but the client still receives
it on `session.idToken` exactly as before.

## Known limitation: id_token expiry versus session lifetime

This is a real, pre-existing limitation. It is **not introduced or fixed by this
change**; it is documented here so it is not mistaken for a regression.

Minister issues short-lived id_tokens (about 10 minutes) and does **not** issue
refresh tokens, does not support `offline_access`, and does not support
`prompt=none` silent re-authentication. The id_token captured at sign-in is never
renewed.

Verified against Minister source (2026-07-08, read-only):

- `apps/minister/src/app/oidc/token/route.ts` rejects every
  `grant_type` other than `authorization_code` (`unsupported_grant_type`), and
  its token response contains no `refresh_token` member at all, so requesting
  `offline_access` cannot yield one.
- `apps/minister/src/lib/oidc-authorize.ts` parses no `prompt` (or `max_age` /
  `id_token_hint`) parameter, and `/oidc/authorize` always renders the
  interactive consent screen - there is no remembered-consent auto-approval -
  so a hidden-iframe `prompt=none` re-auth cannot complete without user
  interaction.
- Minister's project docs list refresh tokens as an explicit non-goal.

A silent id_token refresh therefore requires a Minister-side change (a refresh
grant, or `prompt=none` plus remembered consent). Until one lands, the
supported recovery is the one-click re-auth: the admin page's `expired` state
(`use-is-admin.ts` maps a locally-detected expiry or an API 401 to it) renders
a "Sign in again" button that re-runs `signIn('minister')` and re-persists a
fresh token via `events.signIn`.

The web login session, by contrast, lives for 30 days. So the forwarded bearer
token expires long before the login session does. Once the stored id_token
expires:

- The login session itself stays valid (the user still appears signed in, the
  cookie still maps to a live `Session` row).
- Gated API calls that require a fresh, verifiable id_token fail, because the API
  re-verifies the bearer token on every call and rejects an expired one.
- The only recovery today is for the user to sign in again, which mints a new
  id_token and stores it on the `Account` row.

This mismatch existed under the previous JWT-strategy configuration too: the
id_token baked into the JWT cookie at sign-in was equally never refreshed. The
database-session migration neither worsens nor fixes it.

## Recommended follow-up (not implemented here)

Two directions would close the expiry gap. Both are out of scope for the session
strategy migration and are listed as options with trade-offs.

### Option A: API trusts a Discreetly-issued session instead of re-verifying the Minister id_token indefinitely

Align with Minister's intended design, where a relying party verifies the
id_token once on receipt and then derives and trusts its own session. The web app
verifies the Minister id_token at sign-in (Auth.js already does this during the
OIDC flow), then the API trusts a Discreetly-issued credential tied to the
database session rather than re-verifying a forwarded Minister token on every
call.

- Pros: gated calls keep working for the life of the Discreetly session;
  decouples API access from the 10-minute Minister token; matches Minister's
  intended RP model.
- Cons: the API stops being purely stateless with respect to login; Discreetly
  becomes responsible for issuing and validating its own session credential
  (key management, expiry, revocation propagation from the web `Session` table to
  the API); badge freshness has to be reconsidered, since badges would no longer
  ride on a freshly verified Minister token on each call.
- Effort: medium to high. Touches both `apps/web` and `services/api` and the trust
  boundary between them.

### Option B: short-lived re-authentication to refresh the id_token

Keep the API stateless and re-verifying the forwarded token, but refresh the
id_token before it expires by re-running the OIDC flow. Without refresh tokens or
`prompt=none` this generally requires a user-visible (or at least
redirect-based) re-auth.

- Pros: smallest change to the trust model; the API stays stateless and keeps
  re-verifying a fresh Minister token, so badge state is always current.
- Cons: re-auth is user-visible unless Minister later adds silent re-auth or
  refresh tokens; a 10-minute cadence is disruptive; depends on Minister features
  that do not exist today.
- Effort: low to medium on the Discreetly side, but blocked on Minister
  capabilities for a non-disruptive version.

A pragmatic path is Option A for durable API access, optionally combined with a
periodic badge re-check so badge state does not go stale under a long-lived
Discreetly session. Choosing requires deciding how fresh badge assertions must be
for room gating, which is a product decision rather than a purely technical one.

## API auth model (unchanged, for context)

`services/api` remains stateless. It verifies the Minister id_token bearer token
on each gated call using `createMinisterVerifier` and evaluates the boolean badge
policy from the disclosed badge VCs. This migration did not touch the API auth
path.
