# Discreetly v2 — Admin Backend (Plan 3c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. This plan is executed by tiered subagents dispatched from the orchestrator; security-critical tasks (auth, bans) go to opus `engineer`, plumbing to sonnet `implementer`, with an `auditor` + `reviewer` pass over the full diff.

**Goal:** Add the Minister-authed admin backend to `services/api`: room CRUD, boolean policy validation, ban management (by IC, by join-nullifier, un-ban), membership inspection, audit log, and system broadcast — all over tRPC.

**Architecture:** A new `admin` tRPC sub-router mounted on `appRouter.admin`. Admin identity is a Minister OIDC `id_token` presented as an `Authorization: Bearer <id_token>` header; an `adminProcedure` middleware verifies it and checks the `AdminUser` allowlist by pairwise `sub`. Every admin mutation writes an `AuditLog` row. Ban/un-ban reuse the membership/leaf model and keep the join path consistent (a ban is anchored on a `Membership` row with `status = BANNED`, which the join path already rejects).

**Tech Stack:** tRPC v11, Prisma 6 (Postgres), zod, jose, Node `crypto.scrypt`, `@discreetly/policy`, `@discreetly/crypto`.

**Branch:** `plan-3c-admin-backend` (already created). Tests run with `pnpm --filter @discreetly/api test` (loads `../../.env`), typecheck with `pnpm --filter @discreetly/api typecheck`, policy package with `pnpm --filter @discreetly/policy test`. Postgres (5432) + Redis (6379) are up.

---

## Conventions discovered (read before coding)

- `Context` is `{ verify: VerifyFn }` (`src/trpc/trpc.ts`); `verify(idToken) → { sub, badges }` (`src/minister/verify.ts`).
- Routers use `publicProcedure`/`router` from `src/trpc/trpc.ts`; mounted in `src/trpc/app.router.ts`.
- `prisma` + all Prisma enums (`MembershipStatus`, `BanReason`, …) re-exported from `@discreetly/db`.
- Existing ban-on-collision logic: `src/messaging/ban.ts` (`banOnCollision`) — the admin ban module mirrors its transaction shape but anchors on IC/join-nullifier instead of Shamir recovery.
- `getRateCommitmentHash(ic: bigint, limit) → bigint` and `genId`, `randomBigInt` from `@discreetly/crypto`.
- Policy: `PolicyNode`, `evaluate`, `requiredScopes` from `@discreetly/policy`. `{ allOf: [] }` ⇒ open (admit-all); `{ anyOf: [] }` ⇒ closed; a bare `{}` is NOT a valid policy (throws). Use `OPEN_POLICY = { allOf: [] }`.
- Realtime: `publishMessage(BroadcastMessage)` + `roomMessages(roomId, signal)` in `src/realtime/broadcast.ts`; `roomChannel`, `publisher`, `makeSubscriber` in `src/realtime/redis.ts`.
- Tests use `appRouter.createCaller(ctx)` with a mock verifier built from `src/test/mock-issuer.ts` (`signIdToken`, `jwks`, `MOCK_*`). Each test seeds rooms via `prisma.room.create` and cleans up in `afterAll`.
- The redacted room field set `PUBLIC_ROOM_FIELDS` lives in `src/trpc/room.router.ts` (excludes `passwordHash`). Admin room responses must also exclude `passwordHash`.

---

## Task 1 (engineer / opus): Admin auth foundation + policy schema + system-broadcast plumbing

**Files:**
- Modify: `packages/policy/src/index.ts`
- Create: `packages/policy/src/schema.ts`
- Create: `packages/policy/src/schema.test.ts`
- Modify: `services/api/src/trpc/trpc.ts` (extend `Context`, add `adminProcedure` + `audit` helper, or split into new files)
- Create: `services/api/src/trpc/admin-procedure.ts` (admin middleware) — if not folded into trpc.ts
- Create: `services/api/src/admin/audit.ts` (audit-log writer)
- Create: `services/api/src/admin/admin.router.ts` (skeleton + `whoami`)
- Modify: `services/api/src/trpc/app.router.ts` (mount `admin`)
- Modify: `services/api/src/server.ts` (Authorization header → `adminIdToken` in context, HTTP + WS)
- Create: `services/api/src/admin/admin-auth.test.ts`
- Modify: `services/api/src/realtime/broadcast.ts` (discriminated union + `publishSystem`)
- Create/Modify: `services/api/src/realtime/broadcast.system.test.ts`

**Behavior:**

1. **Policy schema (`packages/policy/src/schema.ts`):** a recursive zod schema matching `PolicyNode`, plus helpers. Empty `allOf`/`anyOf`/`atLeast.of` arrays are allowed (they are meaningful — see conventions). `.strict()` on each object so unknown keys are rejected.

```ts
import { z } from 'zod';
import type { PolicyNode } from './types.js';

const attrValue = z.union([z.string(), z.number(), z.boolean()]);

const badgeLeaf = z
  .object({
    badge: z
      .object({
        type: z.string().min(1),
        where: z.record(attrValue).optional(),
        maxAgeDays: z.number().positive().optional(),
      })
      .strict(),
  })
  .strict();

export const policyNodeSchema: z.ZodType<PolicyNode> = z.lazy(() =>
  z.union([
    badgeLeaf,
    z.object({ allOf: z.array(policyNodeSchema) }).strict(),
    z.object({ anyOf: z.array(policyNodeSchema) }).strict(),
    z
      .object({ atLeast: z.object({ n: z.number().int().nonnegative(), of: z.array(policyNodeSchema) }).strict() })
      .strict(),
  ]),
);

/** Parse + validate untrusted JSON into a PolicyNode; throws ZodError on invalid input. */
export function parsePolicy(input: unknown): PolicyNode {
  return policyNodeSchema.parse(input);
}

/** The admit-all policy (open room): allOf of zero predicates evaluates true. */
export const OPEN_POLICY: PolicyNode = { allOf: [] };
```

   - Export from `packages/policy/src/index.ts`: add `export * from './schema.js';`.
   - Tests (`schema.test.ts`): valid leaf, nested allOf/anyOf/atLeast, `OPEN_POLICY`; invalid: bare `{}`, unknown key (`{ allOf: [], foo: 1 }`), wrong attr type, negative `maxAgeDays`. Assert `parsePolicy` throws on invalid and round-trips `evaluate`-compatible output on valid.

2. **Context + admin auth (`services/api/src/trpc/trpc.ts` and/or `admin-procedure.ts`):**

```ts
// trpc.ts
export interface Context {
  verify: VerifyFn;
  /** Raw Bearer id_token from the Authorization header (admin requests only). */
  adminIdToken?: string;
}
```

   Add an `adminProcedure` built on the same `t` instance (export `t`’s middleware or define `adminProcedure` in trpc.ts to keep `t` encapsulated). It must:
   - throw `TRPCError UNAUTHORIZED` if `ctx.adminIdToken` is missing or fails `ctx.verify`;
   - look up `prisma.adminUser.findUnique({ where: { pairwiseSub: sub } })`; throw `FORBIDDEN` if not found;
   - `return next({ ctx: { ...ctx, adminSub: sub } })` so resolvers can read `ctx.adminSub`.

```ts
export const adminProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.adminIdToken) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'admin auth required' });
  let sub: string;
  try {
    ({ sub } = await ctx.verify(ctx.adminIdToken));
  } catch {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid admin id_token' });
  }
  const admin = await prisma.adminUser.findUnique({ where: { pairwiseSub: sub } });
  if (!admin) throw new TRPCError({ code: 'FORBIDDEN', message: 'not an admin' });
  return next({ ctx: { ...ctx, adminSub: sub } });
});
```

3. **Audit helper (`services/api/src/admin/audit.ts`):**

```ts
import { prisma } from '@discreetly/db';
import type { Prisma } from '@discreetly/db';

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string;
  metadata?: Prisma.InputJsonValue;
}

/** Write an audit row. Accepts an optional tx client so it can join a ban transaction. */
export async function audit(
  entry: AuditEntry,
  client: { auditLog: { create: (args: { data: AuditEntry }) => Promise<unknown> } } = prisma,
): Promise<void> {
  await client.auditLog.create({ data: entry });
}
```
   (Type the `client` param so it accepts both `prisma` and a `$transaction` tx — simplest is `Prisma.TransactionClient | typeof prisma`.)

4. **Admin router skeleton (`admin.router.ts`)** with one query for the auth test:

```ts
export const adminRouter = router({
  whoami: adminProcedure.query(({ ctx }) => ({ adminSub: ctx.adminSub })),
});
```
   Mount in `app.router.ts`: `admin: adminRouter`.

5. **server.ts wiring:** read `Authorization: Bearer <token>` from `req.headers.authorization` in the HTTP `createContext`, pass as `adminIdToken`. For WS, admin ops are HTTP-only — leave `adminIdToken` undefined (no admin subscriptions). Add a small `bearer(headerValue?: string): string | undefined` helper.

6. **Realtime discriminated union + `publishSystem` (`broadcast.ts`):** convert the yielded type to a discriminated union without changing the concurrency logic:

```ts
export interface ChatBroadcast {
  kind: 'message';
  id: string; roomId: string; epoch: string; content: string; sessionColor?: string; createdAt: string;
}
export interface SystemBroadcast {
  kind: 'system';
  roomId: string; text: string; createdAt: string;
}
export type RoomBroadcast = ChatBroadcast | SystemBroadcast;

export async function publishMessage(msg: Omit<ChatBroadcast, 'kind'>): Promise<void> {
  await publisher().publish(roomChannel(msg.roomId), JSON.stringify({ kind: 'message', ...msg }));
}
export async function publishSystem(roomId: string, text: string, createdAt: string): Promise<void> {
  await publisher().publish(roomChannel(roomId), JSON.stringify({ kind: 'system', roomId, text, createdAt }));
}
```
   `roomMessages` returns `AsyncGenerator<RoomBroadcast>`. Keep the existing abort/parse/quit logic byte-for-byte; only the type and the parsed-payload type change. Update `messaging/pipeline.ts` to call `publishMessage` with the same fields (it already passes the chat fields; just ensure the type lines up — `kind` is added inside `publishMessage`). Update `message.subscribe` yield type via inference (no code change needed).
   - Add a test that `publishSystem` round-trips through `roomMessages` and yields `{ kind: 'system', text }`.

**Tests to write/keep green (`admin-auth.test.ts`):** no header → `UNAUTHORIZED`; valid non-admin token → `FORBIDDEN`; admin token (seed an `AdminUser` with the mock `sub`) → `whoami` returns the sub. Use the mock verifier + `signIdToken({ sub })`. Build the caller with `appRouter.createCaller({ verify: mockVerifier, adminIdToken })`.

- [ ] Write tests → run (fail) → implement → run (pass) → typecheck → commit.

---

## Task 2 (engineer / opus): Ban management

**Files:**
- Create: `services/api/src/admin/ban-admin.ts`
- Create: `services/api/src/admin/ban-admin.test.ts`
- Modify: `services/api/src/admin/admin.router.ts` (add ban procedures)

**Behavior — three operations, each in one Prisma transaction, each writing an `AuditLog` row (action `ADMIN_BAN_IC` / `ADMIN_BAN_NULLIFIER` / `ADMIN_UNBAN`) with the admin `sub` as actor:**

1. `banByJoinNullifier({ roomId, joinNullifier, actor, reason? })`:
   - **upsert** the `Membership` (`@@unique([roomId, joinNullifier])`) with `status: BANNED` on both create and update — this is critical so a join that has never happened is still rejected (the join path checks `membership.status`, not the `Ban` table).
   - `deleteMany` its `MembershipLeaf` rows (prune from the tree).
   - create a `Ban { roomId, joinNullifier, reason: ADMIN }`.
   - audit. Return `{ banned: true, joinNullifier, prunedLeaves }`.

2. `banByIdentityCommitment({ roomId, identityCommitment, userMessageLimit, actor })`:
   - compute `rateCommitment = getRateCommitmentHash(BigInt(ic), userMessageLimit).toString()`.
   - find the leaf by `roomId_rateCommitment`; if none → `{ banned: false, reason: 'no-leaf' }`.
   - else set its `Membership.status = BANNED`, prune all that membership’s leaves, create `Ban { roomId, joinNullifier, rateCommitment, reason: ADMIN }`, audit. Return `{ banned: true, joinNullifier, prunedLeaves }`.

3. `unban({ roomId, joinNullifier, actor })`:
   - set the `Membership.status = ACTIVE` if it exists (if not, still proceed to clear bans);
   - `deleteMany` `Ban` rows for `{ roomId, joinNullifier }`;
   - audit. Return `{ unbanned: true }`. (Note: leaves were pruned at ban time, so the user must re-join/rotate to get a device leaf again — document this in a comment.)

   Admin procedures in `admin.router.ts`: `banByIdentityCommitment`, `banByJoinNullifier`, `unban` (all `adminProcedure.mutation`, zod-validated input, `actor: ctx.adminSub`). For `banByIdentityCommitment`, the procedure loads the room to get `userMessageLimit` (404 if missing).

**Tests (`ban-admin.test.ts`):**
- Seed a room + an active membership/leaf (via `joinRoom` or direct prisma). Ban by IC → membership BANNED, leaves pruned, `Ban` row exists; a subsequent `membership.join` for the same join-nullifier returns `{ ok: false, reason: 'banned' }`.
- Ban by join-nullifier with no prior membership → creates a BANNED membership; a later `membership.join` is rejected `banned`.
- Un-ban → membership ACTIVE, `Ban` rows gone; a later `membership.join` succeeds again.
- Each operation writes exactly one `AuditLog` row with the expected `action` + `actor`.

- [ ] tests → fail → implement → pass → typecheck → commit.

---

## Task 3 (implementer / sonnet): Room CRUD

**Files:**
- Create: `services/api/src/admin/room-admin.ts` (rlnIdentifier generation, password hashing, redaction helper)
- Create: `services/api/src/admin/room-admin.test.ts`
- Modify: `services/api/src/admin/admin.router.ts` (room CRUD procedures)

**Behavior:**

- **rlnIdentifier generation** (`room-admin.ts`): `generateRlnIdentifier(name): string` = `genId(randomBigInt(), name).toString()`. The create path retries on a `rlnIdentifier` unique-constraint violation (Prisma `P2002`) up to a few times.
- **Password hashing** (`room-admin.ts`): `hashRoomPassword(pw): Promise<string>` and `verifyRoomPassword(pw, stored): Promise<boolean>` using Node `crypto.scrypt` with a random 16-byte salt, stored as `scrypt$<saltHex>$<hashHex>`. Use `crypto.timingSafeEqual` for verify. (No new dependency.)
- **Redaction:** reuse the `PUBLIC_ROOM_FIELDS` select (export it from `room.router.ts` or move to a shared `room-fields.ts` and import in both places — DRY) so admin responses never include `passwordHash`.
- Procedures on `admin.router.ts` (all `adminProcedure`):
  - `room.create`: input `{ name, slug, description?, rateLimit, userMessageLimit, maxDevices?, visibility?, persistence?, encryption?, password?, accessPolicy }`. Validate `accessPolicy` with `policyNodeSchema`. If `encryption === 'AES'`, `password` is required → hash it. Generate `rlnIdentifier`. Create. Audit (`ROOM_CREATE`, target = room id). Return redacted room.
  - `room.update`: input `{ id, ...partial }`. Re-validate `accessPolicy` if present; re-hash `password` if present; never change `rlnIdentifier`. Audit (`ROOM_UPDATE`). Return redacted room. 404 if missing.
  - `room.delete`: `{ id }`. Delete (cascades to memberships/leaves/messages/bans). Audit (`ROOM_DELETE`). Return `{ ok: true }`. 404 if missing.
  - `room.list`: all rooms (including PRIVATE) redacted, with `_count` of memberships + messages, newest first.
  - `room.get`: any room by id, redacted. 404 if missing. (Admin bypasses the read gate.)

**Tests (`room-admin.test.ts`):** create (open + AES-with-password) → row exists, `rlnIdentifier` numeric+unique, response has no `passwordHash`; invalid policy rejected; AES without password rejected; update changes fields + re-validates policy; delete removes the room + cascades; list includes a private room; audit rows written. Use an admin caller (seed `AdminUser`).

- [ ] tests → fail → implement → pass → typecheck → commit.

---

## Task 4 (implementer / sonnet): Inspection + audit query + system broadcast

**Files:**
- Modify: `services/api/src/admin/admin.router.ts`
- Create: `services/api/src/admin/inspection.test.ts`

**Behavior (all `adminProcedure`):**
- `room.memberships({ roomId })`: list the room’s memberships with `status`, `joinNullifier`, `createdAt`, and their non-revoked leaves (`identityCommitment`, `rateCommitment`, `deviceLabel`, `createdAt`). 404 if room missing.
- `auditLog({ roomId?, actor?, action?, limit? (default 100, max 500) })`: return recent `AuditLog` rows filtered by the provided fields (target = roomId when `roomId` given), newest first.
- `broadcast({ roomId, text })`: 404 if room missing; call `publishSystem(roomId, text, new Date().toISOString())`; audit (`SYSTEM_BROADCAST`, target = roomId, metadata `{ text }`); return `{ ok: true }`.

**Tests (`inspection.test.ts`):** seed a room + membership/leaf → `room.memberships` returns it; perform an admin action then `auditLog` returns the row (filtered by roomId/action); `broadcast` → a `roomMessages` subscriber receives `{ kind: 'system', text }` and an `AuditLog` row is written. Reuse the realtime test pattern from `message.subscribe.test.ts` / `broadcast` tests.

- [ ] tests → fail → implement → pass → typecheck → commit.

---

## Final review (orchestrator-driven, after all tasks)

1. `pnpm --filter @discreetly/api test` + `pnpm --filter @discreetly/policy test` green; `pnpm --filter @discreetly/api typecheck` + `pnpm --filter @discreetly/policy typecheck` clean; `pnpm format` (respecting `.prettierignore`).
2. **auditor (opus xhigh, read-only)** over the full 3c diff: focus on admin authZ (no privilege bypass, no IDOR), ban/join consistency (can a banned identity rejoin via any path?), policy-validation completeness (can a malformed policy reach `evaluate`?), passwordHash non-disclosure, audit completeness, transaction atomicity, and input validation.
3. **reviewer (opus, read-only)** for code quality / DRY / interface clarity / test quality.
4. Fix-loop any findings, re-run tests.
5. `finishing-a-development-branch`: merge `plan-3c-admin-backend` → `main` locally (fast-forward), delete branch.

## Self-review notes
- Spec coverage: §13 admin dashboard backend (CRUD ✔, policy builder validation ✔ via schema, ban by IC ✔ + by join-nullifier ✔ + un-ban ✔, membership inspection ✔, audit log ✔, system broadcast ✔); §6 admin auth (Tessera/Minister OIDC + pairwise-sub allowlist ✔); §8 AdminUser/AuditLog models (already present ✔).
- Join-path consistency is the subtle correctness point: bans MUST anchor on a `Membership` row with `status = BANNED` (T2), because `joinRoom` checks membership status, not the `Ban` table.
- `OPEN_POLICY = { allOf: [] }`; a bare `{}` is invalid and must be rejected by `policyNodeSchema`.
