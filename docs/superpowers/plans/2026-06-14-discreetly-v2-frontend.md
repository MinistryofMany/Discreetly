# Discreetly v2 — Frontend + Admin UI + E2E (Plan 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Executed by tiered subagents from the orchestrator. Crypto/auth/correctness-critical work (token verification, browser RLN proving, identity encryption) goes to opus `engineer`; UI plumbing to sonnet `implementer`; e2e to opus `engineer`; security review to `auditor`.

**Goal:** Build `apps/web` — the Next 15 / React 19 chat client + admin dashboard — wired to the `services/api` tRPC backend and the Minister OIDC provider, with in-browser RLN proving, and full Playwright e2e coverage of every page, button, and endpoint.

**Architecture:** Next 15 App Router (port 3001) is UI + the Auth.js v5 Minister OIDC client only. All data flows through the long-lived `services/api` tRPC server (HTTP on :3002, WS on :3002). The browser holds the Semaphore identity (secret never leaves the device), builds RLN proofs locally, and forwards the Minister `id_token` to the API for join/admin (the API re-verifies everything). Real-time feed via a tRPC WS subscription. Redis pub/sub already fans broadcasts across API instances.

**Tech Stack:** Next 15 (App Router) / React 19, Tailwind v3 + shadcn/ui, Auth.js v5 (`next-auth@beta`), tRPC v11 client (`@trpc/client` + `@trpc/tanstack-react-query` + `@tanstack/react-query`), `@discreetly/crypto` (`/rln` subpath), `@discreetly/policy`, `@discreetly/shared`, `zod`. WebCrypto for identity encryption. Playwright for e2e.

**Branch:** `plan-4-frontend` (created). All Plan 4 phases commit here; merge to `main` after e2e is green.

---

## Verified integration contract (from live Minister recon — do not re-derive)

**Minister OIDC** (live at `http://localhost:3000`):
- issuer `http://localhost:3000`; authorize `/oidc/authorize`; token `/oidc/token`; userinfo `/oidc/userinfo`; jwks `/.well-known/jwks.json`.
- PKCE **S256 mandatory**; `state` + `nonce` required; `response_type=code` only; id_token alg **EdDSA**; subject type **pairwise**.
- id_token claims: `sub` (pairwise), `aud`, `iss`, `iat`, `exp`, `nonce`, `name?`, `picture?` (profile scope), and **`minister_badges`** = `string[]` of VC JWTs (omitted when none disclosed).
- VC: `iss = did:web:minister.local`, header `typ: vc+jwt`, `vc.type = ["VerifiableCredential","Minister<Pascal>Credential"]` (e.g. `MinisterEmailDomainCredential`), `credentialSubject = { id: "did:web:minister.local:users:<id>", ...attrs }`.
- Scopes available: `openid`, `profile`, and `badge:<type>` for email-domain, email-exact, oauth-account, residency-country/state/city, invite-code, tlsn-attestation, age-over-{16,18,21,25,30,35,40,45,55,65}.

**Discreetly OIDC client** (per `.env`): `MINISTER_CLIENT_ID=discreetly_dev`, secret in `.env` only, redirect `http://localhost:3001/api/auth/callback/minister`. AUTH_URL = `http://localhost:3001`.

**Auth.js provider to mirror** (Minister's `apps/demo-client/src/auth.ts`): `type: "oidc"`, `id: "minister"`, `issuer`, `clientId/clientSecret` from env, `authorization.params.scope`, `checks: ["pkce","state","nonce"]`. Persist `account.id_token` into the session via the jwt callback so the browser can forward it to the API.

**Constraint:** Minister runs as a host `next dev` process actively developed by another effort. DO NOT restart it, change its env, or write to its DB. Browser e2e therefore uses a self-hosted faithful **mock OIDC issuer** (deterministic, non-disruptive). Live-interop is covered by (a) a live discovery/JWKS reachability test over HTTP, and (b) the existing opt-in DB-mediated token grant (`services/api/src/test/minister-live.ts`, enabled only when `MINISTER_DEV_DATABASE_URL` is set — leave disabled by default).

**Circuits:** browser fetches `packages/circuits/artifacts/rln/{circuit.wasm,final.zkey}` as `Uint8Array`. Copy them into `apps/web/public/circuits/rln/` via a build/predev step; pass them to `generateRLNProof(inputs, { wasm, zkey })`.

**API surface (already built, services/api):**
- `room.listPublic` / `room.get({id, idToken?})` / `room.leaves({id, idToken?})`
- `membership.join({roomId, idToken, identityCommitment, deviceLabel?})` / `membership.rotate({roomId, idToken, oldIdentityCommitment, newIdentityCommitment})`
- `message.send({roomId, content, proof, sessionColor?})` / `message.subscribe({roomId, idToken?})` (yields `RoomBroadcast = {kind:'message',...} | {kind:'system', text, ...}`)
- `admin.*` (Authorization: Bearer id_token): `whoami`, `room.{create,update,delete,list,get,memberships}`, `banByIdentityCommitment`, `banByJoinNullifier`, `unban`, `auditLog`, `broadcast`. Admin allowlist = `AdminUser.pairwiseSub`.

---

## Phase 4.0 (engineer / opus): Backend Minister-rename completion + live reachability

The backend still speaks the pre-rename contract. Fix so it matches live Minister, keep all unit tests green.

**Files:** `services/api/src/minister/verify.ts`, `services/api/src/minister/badge-type.ts`, `services/api/src/test/mock-issuer.ts`, `services/api/src/minister/verify.live.test.ts`, plus a new `services/api/src/minister/verify.live-reachability.test.ts`. Grep `services/api` for any remaining `tessera` and fix.

- `verify.ts`: read `payload.minister_badges` (was `tessera_badges`).
- `badge-type.ts`: regex `/^Minister(.+)Credential$/` (was `Tessera`).
- `mock-issuer.ts`: emit `minister_badges` and `Minister<Pascal>Credential` so unit tests mirror the real contract. Rename `MOCK_VC_ISSUER` value to `did:web:mock.minister` (already mock-prefixed — keep) and any `Tessera` strings.
- New reachability test (runs against live Minister; `describe.skipIf` if `http://localhost:3000/.well-known/openid-configuration` is unreachable): assert issuer, `EdDSA` in `id_token_signing_alg_values_supported`, `minister_badges` in `claims_supported`, and that `createRemoteJWKSet(jwks_uri)` loads at least one key. Do NOT touch Minister's DB.
- Keep `verify.live.test.ts` opt-in (DB-mediated) as-is.

Toolchain: `pnpm --filter @discreetly/api test`, `pnpm --filter @discreetly/api typecheck`. Keep 87 passed + 1 skipped green (the skip may now run if Minister is reachable — fine).

---

## Phase 4.1 (engineer / opus): Web scaffold + Auth.js + tRPC client

Scaffold `apps/web` and wire the two integration backbones. Add `apps/web` to `pnpm-workspace.yaml` / turbo if needed.

**Deliverables:**
- `apps/web/package.json` (Next 15, React 19, next-auth@beta, @trpc/client, @trpc/tanstack-react-query, @tanstack/react-query, tailwindcss@3, shadcn deps, zod, workspace crypto/policy/shared). `dev` on port 3001. Add `predev`/`prebuild` that copies circuit artifacts into `public/circuits/rln/`.
- Tailwind + shadcn/ui init (`components.json`, `globals.css`, base `Button`, `Input`, `Card`, `Dialog`, `Table`, `Badge`, `Toast` components — add as used).
- `src/auth.ts` — Auth.js v5 Minister OIDC provider (mirror demo-client). Request scope `openid profile` + the badge scopes the app supports (email-domain, invite-code, oauth-account, residency-country, age-over-18 — the live ones plus common). jwt callback persists `id_token`, `sub`, `name`, `picture`, `minister_badges`; session callback exposes them. `src/app/api/auth/[...nextauth]/route.ts`.
- `src/lib/trpc.ts` + provider — `@trpc/client` split link: `wsLink` (browser `WebSocket` to `ws://localhost:3002`) for `subscription`, `httpBatchLink` (`http://localhost:3002`) otherwise. `headers()` adds `Authorization: Bearer <session id_token>` when present (used by admin procedures; harmless elsewhere). Import `AppRouter` type from `@discreetly/api`.
- `src/app/layout.tsx` + providers (SessionProvider, QueryClientProvider, tRPC). A minimal `/` home page: shows "Sign in with Minister" when logged out, the user `name`/`sub` when logged in, and the public room list (`room.listPublic`).
- `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_API_WS_URL` env (default `http://localhost:3002` / `ws://localhost:3002`). `.env.example`.

**Smoke verification:** `pnpm --filter @discreetly/web typecheck` clean; `pnpm --filter @discreetly/web build` succeeds; `next dev` boots on 3001 and `/` renders the sign-in button (verified in Phase 4.5 Playwright). Document any internal-package/`transpilePackages` config needed for Next to consume the TS-source workspace packages (`transpilePackages: ['@discreetly/crypto','@discreetly/policy','@discreetly/shared','@discreetly/circuits']`).

---

## Phase 4.2 (engineer / opus — crypto): Identity + browser RLN proving

The trickiest phase. De-risk browser RLN FIRST (a Playwright/headless spike that generates one real proof) before building UI on it.

**Deliverables:**
- `src/lib/identity.ts` — generate a Semaphore identity (`@semaphore-protocol/identity` via `@discreetly/crypto`); `secret`/`commitment`; encrypt the secret with a user password (PBKDF2-SHA256 ≥210k iters → AES-GCM via WebCrypto); persist ciphertext + salt + iv in `localStorage` (key never persisted); load/unlock; export/import a backup JSON; "rotate" (new identity, keep membership via `membership.rotate`). Unit-test the encrypt/unlock/export/import round-trip (vitest jsdom or node WebCrypto).
- `src/lib/rln.ts` — `proveMessage({ room, identity, content, epoch })`: fetch wasm/zkey `Uint8Array` from `/circuits/rln/*` (cache), build the room group from `room.leaves` (`@discreetly/crypto/rln buildGroup` + `merkleProofForLeaf`), compute `x = calculateSignalHash(content)`, `messageId`, `rateCommitment`, call `generateRLNProof(inputs, { wasm, zkey })`. Returns the `RLNFullProof` to pass to `message.send`.
- **De-risk spike (MANDATORY, do before the chat UI):** a Playwright test (or a headless harness) that loads a page calling `proveMessage(...)` with a seeded identity/leaf set and asserts a proof is produced AND that `services/api` `verifyRLNProof` accepts it (round-trip browser-prove → server-verify). If browser bundling of `rlnjs`/`ffjavascript`/wasm fails under Next, resolve it here (webpack/turbopack config, `wasm` asset handling, `transpilePackages`) — this gates the whole chat flow. Report the resolution.

**Privacy invariant:** the identity secret and password never leave the browser, never go to the API, never appear in logs.

---

## Phase 4.3 (implementer / sonnet + engineer for the join/send glue): Chat UI

**Pages/components:**
- Room list (`/`) — public rooms; per-room "you can join" hint from `requiredScopes` vs the session's disclosed badges (`@discreetly/policy requiredScopes`).
- Onboarding/join — given a room policy, show required badges; if the session lacks them, prompt re-consent (sign in requesting the room's badge scopes); on success call `membership.join` with the local IC.
- Conversation view (`/rooms/[id]`) — `message.subscribe` live feed (handle `kind:'message'` and `kind:'system'`), message list with per-connection color, identicon, timestamps; message input → `proveMessage` → `message.send`; encrypted-room (AES) password prompt (derive key client-side, encrypt/decrypt content); membership/leaf gating (must be joined to send); device management entry point.
- Identity panel — create/unlock/export/import/rotate, multi-device label.
- Error/empty/loading states; toasts for join/send/ban results.

Wire every action to its tRPC procedure. Use optimistic UI sparingly; rely on the subscription for the source of truth.

---

## Phase 4.4 (implementer / sonnet): Admin dashboard UI (`/admin`)

Gated by an admin session (call `admin.whoami`; if it throws, show "not authorized"). Wire to the admin procedures with `Authorization: Bearer <id_token>`:
- Rooms table (`admin.room.list` with counts) + create/edit dialog (all fields; **boolean policy builder** over allOf/anyOf/atLeast/badge-leaf with attribute constraints + per-predicate `maxAgeDays`; validate client-side with `policyNodeSchema`; `OPEN_POLICY` shortcut); delete with confirm.
- Ban management: ban by IC, ban by join-nullifier, un-ban (forms + result toasts).
- Membership/leaf inspection (`admin.room.memberships`).
- Audit log viewer (`admin.auditLog` with filters: room, actor, action).
- System broadcast composer (`admin.broadcast`).

---

## Phase 4.5 (engineer / opus): Playwright e2e — every button + endpoint

**Mock OIDC issuer for e2e:** a tiny local issuer (reuse the mock-issuer EdDSA key approach) served by the test harness; Discreetly's Auth.js points at it when `E2E_OIDC_ISSUER` is set, and the API runs with a verifier bound to the mock key (test env). It issues id_tokens with `minister_badges` VCs for configurable badges + sub, so tests can simulate any badge set and admin vs non-admin (seed `AdminUser` with the test sub).

**Coverage (every page, button, endpoint):**
- Auth: sign in (mock OIDC) → session shows user; sign out.
- Public: room list renders `listPublic`; open a public room; `room.get`/`leaves` gating (private room blocked when not a member).
- Identity: create, set password, lock/unlock, export, import, rotate.
- Join: room requiring a badge — join blocked without it, succeeds with it (`membership.join`); device limit; banned identity rejected.
- Chat: send a message (browser RLN proof → `message.send`) and see it arrive over the subscription; system broadcast arrives; AES room password round-trip.
- Admin: create/edit/delete room; build a boolean policy; ban by IC / by join-nullifier / un-ban; inspect memberships; filter audit log; send broadcast. Assert each reflects in the DB/UI.
- Negative paths: non-admin hitting `/admin` blocked; invalid policy rejected; wrong room password.
- **Live-interop (non-disruptive):** the discovery/JWKS reachability test from 4.0; the DB-mediated deep test remains opt-in.

**Harness:** Playwright config boots Postgres+Redis (already up), the API (test env + mock verifier), the mock OIDC, and `next dev` (or `next build && start`) on 3001. Clean DB state per spec (unique slugs/subs). Run headless. Target: every interactive control exercised at least once with an assertion.

---

## Final review (orchestrator-driven)

1. All package `typecheck` + `test` green; `apps/web build` green; Playwright e2e green; `pnpm format`.
2. **auditor (opus xhigh)** over the Plan 4 diff: OIDC client security (PKCE/state/nonce, id_token handling, no token leakage to logs/URLs), identity-secret confinement to the browser, admin gating in the UI not trusted by the API (API remains the authority), XSS in message rendering (sanitize), CSRF on mutations, the mock-OIDC test seam cannot leak into prod config.
3. **reviewer (opus)** for component structure, state management, accessibility, test quality.
4. Fix-loop; merge `plan-4-frontend` → `main`.

## Self-review notes
- Spec coverage: §5 (apps/web Next/React/tRPC/Auth.js), §12 (identity, multi-device/rotation, chat, encrypted rooms, coloring, onboarding), §13 (admin dashboard all features). 
- Linchpin de-risked first: browser RLN proving (4.2 spike) gates the chat flow.
- Non-negotiables: identity secret stays in-browser; API re-verifies everything; admin authority is server-side (UI gate is convenience only).
- Minister is not disrupted: mock OIDC for browser e2e; live checks are read-only HTTP + opt-in DB grant.
