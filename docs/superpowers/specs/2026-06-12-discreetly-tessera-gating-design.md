# Discreetly v2 — Modernization + Tessera Badge Gating

- **Date:** 2026-06-12
- **Status:** Approved design, ready for implementation planning
- **Scope:** Rebuild Discreetly as a clean monorepo, replace all "gateways" with Tessera OIDC badge gating, preserve the RLN/ZK core, optimize for maintainability, UX, and scale without vendor lock-in.

---

## 1. Context

Discreetly is an anonymous, federated chat app. Membership in a room is a Semaphore identity commitment held in the room's Merkle tree; messages are authenticated by an RLN (Rate-Limiting Nullifier) zero-knowledge proof of membership that does **not** reveal which member sent them. Exceeding the per-epoch rate limit causes a nullifier collision, which (via Shamir recovery) exposes the sender's secret and enables a ban.

Today the codebase is six loosely-coupled repos linked through published npm packages (not a real monorepo), an active SvelteKit 1.x frontend, a stable-but-frozen Express/Socket.IO/Prisma/MongoDB server, and five "gateways" (invite code, Ethereum, Discord, Jubmoji, The Word) that all funnel into one chokepoint: `updateRoomIdentities(identityCommitment, roomIds)`, which pushes `poseidon(IC, userMessageLimit)` into `room.identities[]`.

This project replaces that entire gateway surface with a single gate driven by **Tessera**, a separate OIDC provider + verifiable-credential badge issuer (worked on in parallel by another effort; out of scope here except as an integration target). Tessera already ships a working OIDC provider (PKCE S256, EdDSA), pairwise pseudonymous `sub`, badges as Ed25519 JWT-VCs requested via `badge:<type>` scopes, a consent screen with per-badge disclosure, `tessera_badges` in the ID token, and a demo relying-party we mirror for integration.

## 2. Goals / Non-goals

**Goals**

- Single clean monorepo; tRPC as the typed API contract; full-stack TypeScript.
- Replace all gateways with Tessera OIDC badge gating, with a boolean access policy per room.
- Preserve the RLN/ZK crypto core unchanged in behavior (parity-tested).
- Multi-device and key-rotation UX with no real hassle.
- Bans that survive RLN-secret rotation.
- Scales horizontally; no vendor lock-in anywhere in the data/runtime path.
- Stack matches Tessera (one mental model across both projects the owner maintains).

**Non-goals (this project)**

- Unlinkable ZK gating (deferred; architecture leaves a clean seam for it — see §4).
- Issuing or designing specific badges / TLSNotary plugins (Tessera's responsibility).
- The `RLN2DHCircuit/` future feature (folder left untouched, not referenced by the build).

## 3. Locked requirements

1. **One membership per Tessera identity, per room.** Gated _by_ badges, but uniqueness is anchored on the Tessera identity, not on any badge (re-issuing a badge must not grant a second membership).
2. **Multi-device with no hassle (model MD-B).** Each device has its own RLN secret/IC; all of a user's devices for a room are grouped under one membership. Different per-device secrets means no cross-device RLN message-ID collisions (which would otherwise cause accidental self-bans).
3. **Easy RLN-secret rotation / transfer.** Losing a device or wiping a browser lets the user generate a new IC and swap it in, keeping the membership. Recovery requires only signing into Tessera.
4. **Ban survives rotation.** A banned user cannot return with a new RLN secret or new IC. The ban is anchored to the Tessera identity via a join-nullifier.
5. **Multi-badge boolean gating.** Rooms gate on `allOf` / `anyOf` / `atLeast(n, of)` over badge leaves, each leaf a badge type plus optional attribute constraints, with optional per-predicate expiry. (No `NOT`: selective disclosure means an undisclosed badge is invisible, so exclusion is unenforceable by construction.)
6. **Admin dashboard** with full room management: CRUD, the boolean policy builder, ban management (by IC and by join-nullifier), membership inspection, audit log, system broadcast.

## 4. Trust model: semi-trusted, ZK-ready

Per-message sender anonymity is guaranteed by RLN regardless of how a member joined — this decision is only about the **join step** and who, if anyone, learns the link between a Tessera identity and a Semaphore commitment.

We adopt the **semi-trusted** model: Discreetly's backend learns `pairwise sub ↔ IC` at join time, verifies the badge VC(s), and adds the user to the room tree. This is strictly more private than today's gateways (e.g. the Ethereum gateway stores a real on-chain `address ↔ IC`): the `sub` is a per-RP pseudonym, uncorrelatable to other apps or to the user's real Tessera identity. Full de-anonymization would require **Tessera and Discreetly to collude** (Tessera knows real↔sub, Discreetly knows sub↔IC; neither alone can join them).

Rationale (every added requirement pushed this way):

- Multi-badge rooms are trivial when the server can read the disclosed VCs; proving N credentials in-circuit is costly.
- Rotation is trivial because the anchor (pairwise sub) is regenerated by Tessera on every login — no recoverable client credential to build/support.
- The owner's explicit priority: maximize privacy but never at the expense of UX, because bad UX means no users.

The full **unlinkable ZK** alternative (server never learns `sub ↔ IC`; per-room nullifier is a circuit output; Tessera issues ZK-friendly credentials) is documented for comparison but deferred. The gate is built behind a clean interface so a single high-sensitivity room could opt into a ZK gate later without reworking the membership/room layer.

Data-flow comparison (saved): `diagrams/dataflow-today.svg`, `diagrams/dataflow-semitrusted.svg`, `diagrams/dataflow-zk.svg`. The orange "link" node tells the whole story: real-world link (today) → pseudonymous link split across two parties (chosen) → no link (deferred ZK).

### The join-nullifier

```
joinNullifier = Poseidon(toField(pairwise_sub), toField(roomId))     // per-room
```

- Per-room, so a user's rooms are unlinkable to each other.
- Stable for a given (user, room), so it dedups joins (requirement 1) and anchors bans (requirement 4).
- Poseidon (not keccak) is chosen so the value is field-friendly and forward-compatible with the deferred ZK gate; the semi-trusted model does not strictly require it.
- Inherent consequence (accepted): a user's successive rotations and device-leaves are linkable _to each other_ under one pseudonym at the server — unavoidable given "ban must persist across rotation."

## 5. Architecture

See `diagrams/arch-overview.svg`.

```
discreetly/
├── apps/web/              # Next 15 / React 19 — chat UI, admin dashboard, Auth.js OIDC client
├── services/api/          # long-lived Node backend — tRPC (http+ws), gate, message pipeline
├── packages/
│   ├── crypto/            # RLN prove/verify, Shamir, IDC verifier, signal hash, rate commitment
│   ├── circuits/          # wasm/zkey artifacts (RLN, idcNullifier)
│   ├── policy/            # access-policy types, requiredScopes(), evaluate()
│   ├── db/                # Prisma schema + client + migrations
│   ├── api/               # tRPC routers + exported AppRouter type
│   └── shared/            # shared TS types/enums (internalized discreetly-interfaces)
├── RLN2DHCircuit/         # untouched (future feature)
├── docker-compose.yml     # postgres + redis + web + api
├── turbo.json · pnpm-workspace.yaml · package.json
```

- **Tooling:** pnpm workspaces + Turborepo, matching Tessera. Local packages linked via `workspace:*` (no publish/bump cycle).
- **Why a separate `services/api`:** the live message feed needs long-lived WebSockets, which Next App Router handles poorly. One Node backend owns all tRPC (queries/mutations over HTTP, subscriptions over WS) and is the single authority. Next is UI + the Auth.js OIDC client only.
- **Stack:** Next 15 (App Router) / React 19, Tailwind + shadcn/ui, Auth.js v5, tRPC v11, Prisma 6, PostgreSQL, Redis. All matching Tessera.

### Data layer (no lock-in, scales)

- **PostgreSQL** — OSS, one wire protocol everywhere; portable across Neon/Supabase/RDS/Crunchy/self-host with zero app changes. Scales via vertical sizing, read replicas, connection pooling (PgBouncer/Supavisor), and message-table partitioning by room+time. Ephemeral rooms never touch disk.
- **Prisma** — most readable schema representation; first-class migrations; OSS on any Postgres (we never use the proprietary Accelerate/Data Platform, so nothing to lock into). The usual "Prisma at scale" serverless connection-storm problem does not apply because the backend is a long-lived Node process using a normal pooled connection. (Drizzle was the considered alternative; clean swap if ever wanted.)
- **Redis** — pub/sub fan-out so stateless backend instances can broadcast to all room subscribers; OSS, self-hostable.

## 6. Authentication + the gate

- **Auth.js in Next** runs the Tessera OIDC dance (mirrors Tessera's demo-client; `checks: ["pkce","state","nonce"]`), obtaining a signed `id_token` carrying the pairwise `sub` and `tessera_badges` (VC JWTs).
- **The backend is the authority and trusts nothing from the web tier.** Join forwards the raw `id_token` plus its `tessera_badges`. The real security check is that **each badge is an independently Tessera-signed JWT-VC** — the backend verifies each VC's signature, issuer (`did:web` / JWKS), `exp`, and subject binding directly, so a tampered or forged badge fails regardless of the envelope. It also checks the `id_token` signature, `aud` (our client_id), and `exp` to bind the disclosed `sub`. (`state`/`nonce` are the web-tier Auth.js client's concern.) Stateless — no shared session required. Join is idempotent via nullifier dedup, so an `id_token` replayed within its `exp` window merely re-asserts the same membership.
- **Admin auth:** admins sign in via Tessera OIDC; Discreetly holds an admin allowlist keyed by the admin's pairwise `sub`. Replaces today's HTTP Basic auth.

## 7. Access policy model

A room stores a boolean expression tree over badge predicates:

```jsonc
// node = allOf | anyOf | atLeast{n,of} | badge-leaf
// badge-leaf: { badge: { type, where?: {<attr>:<value>}, maxAgeDays?: number } }
```

Two pure, independently-testable functions in `packages/policy`:

- `requiredScopes(policy) → string[]` — union of referenced badge types → the `badge:<type>` scopes Discreetly requests from Tessera (drives the consent screen).
- `evaluate(policy, verifiedBadges) → boolean` — run server-side after VC verification; attribute matching is the `credentialSubject` check, `maxAgeDays` checks VC `iat`.

Worked examples:

```jsonc
// "Beat Game X on Steam" — sybil-resistant
{ allOf: [
    { atLeast: { n: 2, of: [
        { badge: { type: "oauth-account", where: { provider: "github" } } },
        { badge: { type: "oauth-account", where: { provider: "google" } } },
        { badge: { type: "oauth-account", where: { provider: "steam"  } } } ] } },
    { badge: { type: "steam-game", where: { gameId: "GAME_X", completed: true } } }
]}

// "Citizens of <country> who also work at <company>"
{ allOf: [
    { badge: { type: "residency-country", where: { country: "PT" } } },
    { badge: { type: "email-domain",      where: { domain: "acme.com" } } }
]}
```

Privacy note (inherent to semi-trusted): evaluating attribute constraints means the backend sees the disclosed attribute values (country, domain, etc.).

**Cross-project dependency:** the gate is badge-type-agnostic and works the moment Tessera can issue a given badge. `email-domain`, `oauth-account` (GitHub), and `invite-code` are live in Tessera now; `residency`/passport, `age-over-N`, and `steam-game` need Tessera's TLSNotary plugins (not yet shipped). Discreetly can ship gating on the available badges immediately; marquee rooms light up automatically as Tessera ships the rest. Not a blocker.

## 8. Data model (Prisma / Postgres)

Sketch — `packages/db/schema.prisma` is canonical once written.

- **Room** — `name`, `slug` (unique), `description?`, `rateLimit` (ms/epoch), `userMessageLimit`, `maxDevices` (default 5), `visibility` (PUBLIC|PRIVATE), `persistence` (PERSISTENT|EPHEMERAL), `encryption` (PLAINTEXT|AES) + `passwordHash?`, `accessPolicy` (Json boolean tree), `rlnIdentifier` (unique, poseidon-derived).
- **Membership** — `roomId`, `joinNullifier`, `status` (ACTIVE|BANNED); `@@unique([roomId, joinNullifier])`. One human, one membership per room.
- **MembershipLeaf** — one per device: `membershipId`, `roomId`, `identityCommitment`, `rateCommitment = Poseidon(IC, userMessageLimit)` (the actual Merkle leaf), `deviceLabel?`, `revokedAt?`; `@@unique([roomId, rateCommitment])`.
- **Ban** — `roomId`, `joinNullifier?` (durable, rotation-proof), `rateCommitment?`, `reason` (RATE_LIMIT_COLLISION|ADMIN|…), `shamirSecret?` (forensics), `createdAt`.
- **Message** — `roomId`, `epoch` (BigInt), `rlnNullifier`, `content` (maybe encrypted), `proof` (Json), `sessionColor?`; `@@unique([roomId, epoch, rlnNullifier])` so collision detection is enforced at the DB layer.
- **AdminUser** — `pairwiseSub` (unique), `label`, `createdAt`.
- **AuditLog** — `actor`, `action`, `target`, `metadata` (Json), `createdAt`.

## 9. Key flows

**Join** (`diagrams/seq-join.svg`)

1. Browser holds a Semaphore identity (secret stays local; `IC = hash(secret)`).
2. Auth.js obtains `id_token { pairwise sub, badge VCs }` from Tessera (user consents to disclosure).
3. Browser → Next server action `join(roomId, IC)` → backend `membership.join({ roomId, IC, idToken })`.
4. Backend verifies token + VC signatures vs JWKS; `policy.evaluate()`; computes `joinNullifier`; rejects if used or banned; else creates Membership + first MembershipLeaf and pushes `rateCommitment` into the room tree.

**Rotate / add device** (`diagrams/seq-rotate.svg`)

- Same auth. Look up `joinNullifier`; if banned, reject; else add a new MembershipLeaf (new device) or swap the IC of an existing one, updating the tree. Survives RLN-secret loss because the nullifier is Tessera-anchored.

**Send message**

- Browser builds the RLN proof (Merkle path from the room's leaves), encrypts content for AES rooms, sends via a tRPC-over-WS mutation.
- Backend pipeline (ported): RLN verify (epoch within ±1, signal hash matches `x`, Merkle root matches room tree, snark verify) → collision check (nullifier in this room+epoch, DB-enforced + ephemeral in-memory) → store (persistent) or in-memory (ephemeral) → broadcast via Redis pub/sub to all instances → subscribers.

**Ban** (`diagrams/seq-ban.svg`) — implemented, not the current commented-out stub

- Collision → `shamirRecovery(x1,x2,y1,y2)` → identity secret → IC → owning Membership → in one Postgres transaction: set Membership.status = BANNED, banlist the `joinNullifier`, prune all its MembershipLeaf rows from the tree, write AuditLog.
- Admin can ban manually by IC or by join-nullifier, and un-ban.

## 10. Real-time transport

tRPC v11 with a WebSocket link — mutations to send, subscriptions for the live feed — so the entire API is one paradigm. Redis pub/sub fans broadcasts across backend instances for horizontal scale. Per-room subscription channels. Socket.IO is the documented fallback if a tRPC-subscription limitation surfaces.

## 11. Crypto core carryover

Lift into `packages/crypto` + `packages/circuits`, behavior unchanged, with tests asserting parity against the current implementation so the rewrite cannot silently break proofs:

- RLN prover (browser) and verifier (node); Shamir recovery; IDC verifier; `signalHash`.
- `genId`, `getRateCommitmentHash`, `str2BigInt`, `randomBigInt` (from the old `interfaces` utils).
- The wasm/zkey artifacts for RLN and idcNullifier (served to the browser by `apps/web`).
- Carry forward the known BigInt `n`-suffix parse workaround.

## 12. Frontend (apps/web)

- **Identity:** generate Semaphore identity in-browser; encrypt with a user password (PBKDF2 → AES-GCM); persist ciphertext in localStorage; memory-only key (never persisted). Backup/export retained.
- **Multi-device / rotation:** each device generates its own identity and registers a leaf via Tessera login; rotation = new identity + swap.
- **Chat:** room list, conversation view, message input, encrypted-room password handling, message coloring (replacing the old socket `sessionId` with a per-connection color token).
- **Onboarding:** sign in with Tessera → see which rooms the user's badges satisfy → consent + join.

## 13. Admin dashboard (apps/web, Tessera-authed)

Room CRUD; a boolean **policy builder** UI over `allOf`/`anyOf`/`atLeast`/badge-leaf with attribute constraints + per-predicate expiry; ban management by IC and by join-nullifier (with un-ban); membership/leaf inspection; audit log; system broadcast.

## 14. Dropped

All five gateways and their UIs; **Bandada** (membership is now fully local); the **Discord bot**; **claimcodes** (replaced by Tessera's `invite-code` badge); `frontend-v2/`, `old/`; **MongoDB**.

## 15. Decisions / defaults (confirmed)

| Decision            | Choice                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| Stack               | Next 15 / React 19 / Tailwind+shadcn / Auth.js v5 / tRPC v11, matching Tessera |
| Database / ORM      | PostgreSQL + Prisma                                                            |
| Real-time           | tRPC-over-WebSocket + Redis pub/sub (Socket.IO fallback)                       |
| Trust model         | Semi-trusted, ZK-ready seam                                                    |
| Multi-device        | MD-B (per-device leaves grouped under join-nullifier)                          |
| `maxDevices`        | 5 (per room, configurable)                                                     |
| join-nullifier hash | Poseidon over (sub, roomId)                                                    |
| Admin auth          | Tessera OIDC + pairwise-sub allowlist                                          |
| Invites             | Tessera `invite-code` badge (drop native claimcodes)                           |
| Monorepo tooling    | pnpm workspaces + Turborepo                                                    |

## 16. Out of scope / future

- Unlinkable ZK gating (seam preserved; would need Tessera ZK-friendly credential issuance).
- `RLN2DHCircuit/` future feature (untouched).
- Badge/plugin work on the Tessera side, including TLSNotary-backed badges.
- Per-room admin delegation (v2 uses a global admin allowlist).
