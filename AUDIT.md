# Security audit — Phase 1 per-room badge disclosure

Scope: the per-room minimal badge-disclosure feature (commit `c050051`): the
durable `ProvenBadge` store, per-room scope computation, the join gate's
`(live token badges) ∪ (durable proven types)` evaluation, and the disclosure
capture at the Auth.js OAuth callback.

## Verdict

**GO with conditions.** No Critical or High issue that blocks shipping. The
load-bearing anonymity/over-disclosure invariant holds (see below). One High
finding (H-1) is an OPEN owner decision, not a defect; the Medium findings are
accepted properties of the existing auth model and are now documented in code;
the two Low findings are fixed in this branch.

## Load-bearing invariant (verified)

**Fork F-D: the durable store can only shrink disclosure, never over-admit.**
The `ProvenBadge` store records only that a user (keyed on the verified pairwise
`sub`, never client input) proved a badge TYPE at least once — no VC, no
attribute values, no issued-at. `evaluateWithProven`
(`packages/policy/src/evaluate.ts`) therefore satisfies a **bare type-only** leaf
from the durable set, but a **constrained** leaf (`where`/`maxAgeDays`) can ONLY
be satisfied by a live, freshly-verified VC. A load failure of the proven set
fails closed (deny). This is now covered end-to-end by the F-D spec in
`apps/web/e2e/disclosure.spec.ts` (join a bare `age-over-18`, then a constrained
`age-over-18` leaf forces a live re-prove; the durable type alone is denied).

**Over-disclosure to the relying party:** each room join requests exactly ONE
satisfying branch of THAT room's policy (model 2b), never the whole wallet and
never another room's badges. Captured/recorded types are exactly those the fresh
token carries.

## Findings

### H-1 — durable store has no TTL / revocation (OPEN owner decision)

A `ProvenBadge` row is valid forever: once a user proves a bare type, that proof
satisfies bare leaves indefinitely, even if the underlying real-world fact has
since changed or the badge would no longer be issued. This only affects **bare**
leaves (constrained leaves always re-prove live, per F-D), so it is bounded, not
a bypass.

Owner decision required — the two options are implemented for comparison:

- **Ever-valid** (this branch, `feat/per-room-badge-disclosure`): a proven bare
  type satisfies forever. Simplest; maximizes the "don't re-ask" benefit.
- **TTL** (branch `feat/per-room-badge-disclosure-ttl`): a proven bare type
  satisfies a bare leaf only if `firstProvenAt` is within
  `PROVEN_BADGE_TTL_DAYS` (env, default 30; unset/≤0 = no expiry = ever-valid).
  Past the TTL the gate forces a live re-prove. Constrained leaves unaffected.

No revocation channel exists in either option (Minister does not push
revocations); TTL is the available mitigation.

### M-1 — bearer-token replay window (accepted; existing model, documented)

`membership.join` trusts a bearer Minister `id_token`. The gate re-verifies
signature / issuer / audience / expiry, but within the token's (~10 min)
validity window the token is replayable — there is no per-request nonce or
proof-of-possession at the tRPC layer. Anti-replay relies on TLS in transit plus
the short token lifetime. This is the existing system model, not a regression;
documented in code at `services/api/src/trpc/membership.router.ts`.

### M-2 — verifier is a bearer check; audience must be enforced (documented + hardened)

The server verifier is a bearer-token check (sig/iss/aud/exp). The OIDC `nonce`
that binds an id_token to a specific browser login is enforced upstream at the
Auth.js callback (PKCE + state + nonce), not at the API. Accepted and documented
in `services/api/src/disclosure.ts`.

Hardened: `@ministryofmany/client` only enforces the id_token `aud` when its `clientId`
is truthy (`...clientId ? { audience: clientId } : {}`), so an empty/undefined
audience would SILENTLY accept a token minted for any other RP. The API config
(`MINISTER_CLIENT_ID`, `z.string().min(1)`) already makes this unreachable in
production, but `makeVerifier` (`services/api/src/minister/verify.ts`) now
**refuses to construct without a non-empty audience**, so the `aud` check can
never be silently skipped regardless of caller. Covered by a unit test in
`verify.test.ts`.

### L-1 — non-atomic durable write (FIXED)

`recordProvenTypes` previously awaited one `upsert` per badge type. On the
`captureDisclosure` path it runs OUTSIDE any transaction, so a partial failure
could leave an inconsistent subset recorded. Replaced with a single, idempotent
`createMany({ data, skipDuplicates: true })` round-trip
(`services/api/src/membership/proven-badges.ts`). `skipDuplicates` relies on the
`@@unique([userKey, badgeType])` index, so re-recording is a no-op and the
original `firstProvenAt` is preserved. The join path still passes the outer `tx`.

### L-2 — swallowed capture error (FIXED)

`apps/web/src/auth.ts` swallowed capture errors in an empty `catch` (correctly,
so a capture failure never blocks sign-in). It now logs ONLY the safe
`error.message` — never the id_token or any badge VC — mirroring the verifier's
safe-warn style.

## Gate results

typecheck / lint / build green; unit suites (api/policy/web) green; Playwright
`disclosure.spec.ts` (incl. the new F-D spec) and `auth.spec.ts` green. See the
branch report for exact counts.
