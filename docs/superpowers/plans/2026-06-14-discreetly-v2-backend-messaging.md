# Discreetly v2 — Backend 3b: Messaging + Ban + Realtime

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement the real-time message pipeline on `@discreetly/api`: verify a message's RLN proof, detect rate-limit collisions, recover the spammer's secret via Shamir and **ban** them (the long-commented legacy TODO, finally done), persist/broadcast validated messages over Redis pub/sub, and expose `message.send` (mutation) + `message.subscribe` (WS subscription) via tRPC. Start with the two deferred 3a cleanups.

**Architecture:** The message hot path is pure-function-first (verify → collision → ban decision), then DB writes + Redis publish, then a tRPC WS subscription fans out per-room. The RLN epoch is taken from the **proof itself** (`proof.epoch`, which rlnjs binds to the external nullifier), never a client-supplied field, closing the epoch-spoofing gap. `verifyRLNProof` can throw (rlnjs rejects on epoch/identifier mismatch), so every call is wrapped and a throw = reject.

**Tech stack additions:** `ioredis` (pub/sub), `ws` + `@trpc/server/adapters/ws` (subscriptions). Existing: `@discreetly/crypto` (verifyRLNProof, computeRoot, shamirRecovery, getIdentityCommitmentFromSecret, getRateCommitmentHash, calculateSignalHash), `@discreetly/db`, `@trpc/server@11`.

**Reference:** spec §9 (send message, ban), §10 (realtime). Prep: `docs/superpowers/notes/2026-06-14-backend-3b-prep.md` (do T1 from it). Crypto-integration: `docs/superpowers/notes/2026-06-13-plan3-crypto-integration.md`.

## De-risked facts (verified with real proofs)

- A rate-limit collision = two RLN proofs with the same `(identitySecret, epoch, messageId)` but different signal `x`. They share the **same `nullifier`**, with different `(x, y)` points.
- `RLNFullProof` shape: `{ snarkProof: { proof, publicSignals: { x, y, nullifier, root, externalNullifier } }, epoch, rlnIdentifier }`. `epoch` is bound (rlnjs's verify recomputes `externalNullifier` from `proof.epoch` + `rlnIdentifier`).
- **Ban recovery (proven):** `shamirRecovery(BigInt(x1), BigInt(x2), BigInt(y1), BigInt(y2))` returns **exactly** the identity secret; `getIdentityCommitmentFromSecret(secret)` = the identity commitment; `getRateCommitmentHash(IC, userMessageLimit)` = the `rateCommitment` that is the bannable `MembershipLeaf`.

## File structure (created/modified by this plan)

```
services/api/src/
├── config.ts                       # MODIFY (T1: lazy getConfig)
├── minister/verify.ts              # MODIFY (T1: drop production singleton)
├── minister/production-verifier.ts # CREATE (T1)
├── messaging/
│   ├── verify-message.ts           # T2: RLN verify + epoch-from-proof + signal binding
│   ├── verify-message.test.ts
│   ├── collision.ts                # T2: collision detection (DB + proof extraction)
│   ├── collision.test.ts
│   ├── ban.ts                      # T3: Shamir -> recover -> ban membership (txn)
│   ├── ban.test.ts
│   ├── pipeline.ts                 # T4: send() = verify -> collision/ban -> store -> publish
│   └── pipeline.test.ts
├── realtime/
│   ├── redis.ts                    # T4: ioredis pub/sub helpers
│   └── broadcast.ts                # T4/T5: publishMessage + roomMessages async-iterator
├── trpc/message.router.ts          # T4/T5: message.send mutation + message.subscribe
├── trpc/app.router.ts              # MODIFY: mount message router
└── server.ts                       # MODIFY (T5: attach WS server)
packages/crypto/src/index.ts        # MODIFY (T1: drop rln re-export -> subpath)
packages/crypto/package.json        # MODIFY (T1: exports map)
```

---

## Task 1: 3a-deferred cleanups (lazy config + crypto subpath exports)

Apply both deferred items from `docs/superpowers/notes/2026-06-14-backend-3b-prep.md`.

**Files:** `services/api/src/config.ts`, `services/api/src/minister/verify.ts`, `services/api/src/minister/production-verifier.ts` (new), `services/api/src/server.ts`, `services/api/src/minister/verify.live.test.ts`, `packages/crypto/src/index.ts`, `packages/crypto/package.json`, `services/api/package.json`, `services/api/tsconfig.json`, remove `services/api/tsconfig.server.json`.

- [ ] **Step 1: Lazy config.** In `config.ts`, replace `export const config: Config = loadConfig();` with:
```ts
let cached: Config | undefined;
export function getConfig(): Config {
  return (cached ??= loadConfig());
}
```
Keep `loadConfig` + `Config` exports.

- [ ] **Step 2: Move the production verifier out of `verify.ts`.** Delete the trailing `export const verifyMinisterIdToken = makeVerifier({...})` block from `verify.ts` (leave `makeVerifier`, `VerifiedIdentity`, `VerifierDeps`). Create `services/api/src/minister/production-verifier.ts`:
```ts
import { createRemoteJWKSet } from 'jose';
import { getConfig } from '../config.js';
import { makeVerifier } from './verify.js';

let cached: ReturnType<typeof makeVerifier> | undefined;

/** The verifier bound to the configured live Minister JWKS (built lazily). */
export function getProductionVerifier(): ReturnType<typeof makeVerifier> {
  if (!cached) {
    const c = getConfig();
    cached = makeVerifier({
      issuer: c.MINISTER_ISSUER,
      audience: c.MINISTER_CLIENT_ID,
      vcIssuer: c.MINISTER_VC_ISSUER,
      jwks: createRemoteJWKSet(new URL(c.MINISTER_JWKS_URL)),
    });
  }
  return cached;
}
```

- [ ] **Step 3:** Update `server.ts`: `createContext: () => ({ verify: getProductionVerifier() })` (import from `./minister/production-verifier.js`). Update `verify.live.test.ts`: import `getProductionVerifier` and call `getProductionVerifier()(idToken!)` instead of the removed export.

- [ ] **Step 4: Crypto subpath exports.** In `packages/crypto/package.json` add:
```jsonc
"exports": {
  ".": "./src/index.ts",
  "./rln": "./src/rln/index.ts"
}
```
In `packages/crypto/src/index.ts` REMOVE the line `export * from './rln/index.js';` (the default barrel now carries only field, signal-hash, shamir — no Semaphore). crypto's own tests already import via relative paths, so they're unaffected; verify `pnpm --filter @discreetly/crypto test` + `typecheck` still pass.

- [ ] **Step 5: Drop api's phantom Semaphore dep.** In `services/api/package.json` remove `"@semaphore-protocol/group": "3.10.1"` from dependencies. In `services/api/tsconfig.json` remove the `paths` block (back to `{ "compilerOptions": { "noEmit": true, "types": ["node"] }, "include": ["src", "../../packages/shared/src/types/external-shims.d.ts"] }`). Delete `services/api/tsconfig.server.json` and revert the `dev`/`start` scripts in `services/api/package.json` to `tsx watch src/server.ts` / `tsx src/server.ts` (no `--tsconfig`). NOTE: 3b will import `@discreetly/crypto/rln` (verifyRLNProof, computeRoot, shamirRecovery, getIdentityCommitmentFromSecret) in later tasks — when that import is added (T2), re-add a `@semaphore-protocol/group` ambient shim to `packages/shared/src/types/external-shims.d.ts` (NOT a node_modules `paths` pointer) so it resolves cleanly. Add that shim now as part of this task so later tasks just work:

In `packages/shared/src/types/external-shims.d.ts`, append a minimal ambient declaration for the Semaphore Group surface crypto's `rln` uses (verify against the real API; adjust if the installed `@semaphore-protocol/group@3.10.1` types differ):
```ts
declare module '@semaphore-protocol/group' {
  export type MerkleProof = {
    root: bigint | string;
    leaf: bigint | string;
    siblings: (bigint | string)[];
    pathIndices: number[];
  };
  export class Group {
    constructor(id: bigint | number | string, treeDepth?: number, members?: (bigint | string)[]);
    readonly root: bigint | string;
    indexOf(member: bigint | string): number;
    generateMerkleProof(index: number): MerkleProof;
  }
}
```
Then api (and any consumer) resolves `@discreetly/crypto/rln` without a node_modules `paths` pointer. Verify: `pnpm --filter @discreetly/api typecheck` clean WITHOUT the paths override. If the ambient `MerkleProof` shape disagrees with what `rlnjs`/crypto need at a call site (a type error in crypto's own rln files when typechecked via the consumer), fall back to keeping crypto's own `paths` override for crypto's package only (crypto keeps real types) while consumers use the ambient — the two do not conflict because crypto's tsconfig `paths` wins inside crypto. Report which path you took.

- [ ] **Step 6:** `pnpm install`; `pnpm --filter @discreetly/api test` + `typecheck`; `pnpm --filter @discreetly/crypto test` + `typecheck`; `pnpm --filter @discreetly/policy test` — all green. Commit:
```bash
git add packages/crypto packages/shared services/api docs/superpowers/notes
git commit -m "Lazy config, production-verifier module, crypto subpath exports"
```

---

## Task 2: Message verification + collision detection

**Files:** `services/api/src/messaging/verify-message.ts`(+test), `services/api/src/messaging/collision.ts`(+test). Add a shared RLN test helper that produces real (and colliding) proofs.

- [ ] **Step 1: Test helper for real RLN proofs.** Create `services/api/src/test/rln-fixtures.ts` (Node, uses the vendored circuits via `@discreetly/crypto/rln`):
```ts
import { Identity } from '@semaphore-protocol/identity';
import { poseidon2 } from 'poseidon-lite';
import { generateRLNProof, merkleProofForLeaf, getRateCommitmentHash, calculateSignalHash } from '@discreetly/crypto/rln';
import type { RLNFullProof } from 'rlnjs';

export interface ProofCtx {
  identity: Identity;
  rlnIdentifier: bigint;
  userMessageLimit: bigint;
  rateCommitment: bigint;
  leaves: bigint[];
}

export function makeProofCtx(rlnIdentifier = 12345n, userMessageLimit = 1n): ProofCtx {
  const identity = new Identity();
  const rateCommitment = poseidon2([identity.commitment, userMessageLimit]);
  return { identity, rlnIdentifier, userMessageLimit, rateCommitment, leaves: [rateCommitment] };
}

export async function proofFor(ctx: ProofCtx, message: string, epoch: bigint, messageId = 0n): Promise<RLNFullProof> {
  const merkleProof = merkleProofForLeaf(ctx.rlnIdentifier, ctx.leaves, ctx.rateCommitment);
  return generateRLNProof({
    rlnIdentifier: ctx.rlnIdentifier,
    identitySecret: ctx.identity.secret,
    userMessageLimit: ctx.userMessageLimit,
    messageId,
    merkleProof,
    x: calculateSignalHash(message),
    epoch,
  });
}
```
(`@discreetly/crypto/rln` is the subpath added in T1. `getRateCommitmentHash`/`calculateSignalHash` are exported from the main barrel; import them from `@discreetly/crypto` if the subpath doesn't re-export them — adjust imports to where they actually live.)

- [ ] **Step 2: `verify-message.ts`** — verify a message's proof, taking the epoch FROM the proof:
```ts
import type { RLNFullProof } from 'rlnjs';
import { verifyRLNProof, computeRoot, calculateSignalHash } from '@discreetly/crypto/rln';

export interface VerifyMessageInput {
  rlnIdentifier: bigint;
  proof: RLNFullProof;
  content: string;
  leaves: readonly (string | bigint)[];
  currentEpoch: bigint;
  epochErrorRange?: bigint;
}

export type VerifyMessageResult =
  | { ok: true; epoch: bigint; nullifier: string; x: string; y: string }
  | { ok: false; reason: 'bad-epoch' | 'bad-signal' | 'bad-proof' };

/** Verify an incoming message's RLN proof. Epoch is the proof-bound value, not client-supplied. */
export async function verifyMessage(input: VerifyMessageInput): Promise<VerifyMessageResult> {
  const epoch = BigInt(input.proof.epoch);
  const range = input.epochErrorRange ?? 1n;
  if (epoch < input.currentEpoch - range || epoch > input.currentEpoch + range) {
    return { ok: false, reason: 'bad-epoch' };
  }
  const signalHash = calculateSignalHash(input.content);
  const ps = input.proof.snarkProof.publicSignals;
  if (signalHash !== BigInt(ps.x)) return { ok: false, reason: 'bad-signal' };
  const expectedRoot = computeRoot(input.rlnIdentifier, input.leaves);
  let valid = false;
  try {
    valid = await verifyRLNProof({
      rlnIdentifier: input.rlnIdentifier,
      proof: input.proof,
      signalHash,
      epoch,
      currentEpoch: input.currentEpoch,
      epochErrorRange: range,
      expectedRoot,
    });
  } catch {
    return { ok: false, reason: 'bad-proof' }; // verifyRLNProof throws on epoch/identifier mismatch
  }
  if (!valid) return { ok: false, reason: 'bad-proof' };
  return { ok: true, epoch, nullifier: String(ps.nullifier), x: String(ps.x), y: String(ps.y) };
}
```

- [ ] **Step 3: `verify-message.test.ts`** — using `rln-fixtures`: a valid proof verifies; a tampered content (`x` mismatch) → `bad-signal`; an out-of-window epoch → `bad-epoch`. (Real proof generation; allow 60s timeout — already set in vitest.config.)

- [ ] **Step 4: `collision.ts`** — given a verified message, find a prior message in the same `(roomId, epoch, nullifier)` and decide collision:
```ts
import { prisma } from '@discreetly/db';

export interface PriorPoint { x: string; y: string }

export type CollisionCheck =
  | { kind: 'new' }
  | { kind: 'duplicate' }                       // exact replay (same x): ignore
  | { kind: 'collision'; prior: PriorPoint };   // same nullifier, different x: ban

/** Look for a stored message that shares this nullifier in the same room+epoch. */
export async function checkCollision(args: {
  roomId: string; epoch: bigint; nullifier: string; x: string;
}): Promise<CollisionCheck> {
  const prior = await prisma.message.findFirst({
    where: { roomId: args.roomId, epoch: args.epoch, rlnNullifier: args.nullifier },
    select: { proof: true },
  });
  if (!prior) return { kind: 'new' };
  const ps = (prior.proof as { snarkProof: { publicSignals: { x: string; y: string } } }).snarkProof.publicSignals;
  if (String(ps.x) === args.x) return { kind: 'duplicate' };
  return { kind: 'collision', prior: { x: String(ps.x), y: String(ps.y) } };
}
```

- [ ] **Step 5: `collision.test.ts`** — integration (real DB + real proofs from `rln-fixtures`): store one message, then a second proof with the SAME ctx/epoch/messageId but different content → `checkCollision` returns `collision` with the prior point; the same content again → `duplicate`; a fresh nullifier → `new`.

- [ ] **Step 6:** `pnpm --filter @discreetly/api test` green; typecheck clean. Commit:
```bash
git add services/api/src/messaging/verify-message.ts services/api/src/messaging/verify-message.test.ts services/api/src/messaging/collision.ts services/api/src/messaging/collision.test.ts services/api/src/test/rln-fixtures.ts
git commit -m "Add RLN message verification and collision detection"
```

---

## Task 3: Ban on collision (Shamir recovery)

**Files:** `services/api/src/messaging/ban.ts`(+test).

- [ ] **Step 1: `ban.ts`** — recover the secret from two colliding points, map to the leaf, ban the whole membership atomically:
```ts
import { prisma, BanReason, MembershipStatus } from '@discreetly/db';
import { shamirRecovery, getIdentityCommitmentFromSecret, getRateCommitmentHash } from '@discreetly/crypto';

export interface BanInput {
  roomId: string;
  userMessageLimit: number;
  x1: string; y1: string; // stored (prior) point
  x2: string; y2: string; // new (colliding) point
}

export type BanOutcome =
  | { banned: true; joinNullifier: string; prunedLeaves: number }
  | { banned: false; reason: 'no-leaf' };       // recovered IC not a current member (already pruned)

/** Recover the spammer's secret via Shamir, find their leaf, ban the membership. */
export async function banOnCollision(input: BanInput): Promise<BanOutcome> {
  const secret = shamirRecovery(BigInt(input.x1), BigInt(input.x2), BigInt(input.y1), BigInt(input.y2));
  const identityCommitment = getIdentityCommitmentFromSecret(secret);
  const rateCommitment = getRateCommitmentHash(identityCommitment, input.userMessageLimit).toString();

  return prisma.$transaction(async (tx) => {
    const leaf = await tx.membershipLeaf.findUnique({
      where: { roomId_rateCommitment: { roomId: input.roomId, rateCommitment } },
      select: { membershipId: true },
    });
    if (!leaf) return { banned: false as const, reason: 'no-leaf' as const };

    const membership = await tx.membership.update({
      where: { id: leaf.membershipId },
      data: { status: MembershipStatus.BANNED },
      select: { joinNullifier: true },
    });
    // prune ALL of the membership's leaves from the room tree
    const pruned = await tx.membershipLeaf.deleteMany({ where: { membershipId: leaf.membershipId } });
    await tx.ban.create({
      data: {
        roomId: input.roomId,
        joinNullifier: membership.joinNullifier,
        rateCommitment,
        reason: BanReason.RATE_LIMIT_COLLISION,
        shamirSecret: secret.toString(),
      },
    });
    return { banned: true as const, joinNullifier: membership.joinNullifier, prunedLeaves: pruned.count };
  });
}
```
(`shamirRecovery`/`getIdentityCommitmentFromSecret` live in `@discreetly/crypto` (shamir.ts, main barrel); `getRateCommitmentHash` in field.ts (main barrel). Confirm import paths.)

- [ ] **Step 2: `ban.test.ts`** — integration: create a room + a membership with a leaf for a known identity (use `rln-fixtures` to get the identity + its rateCommitment, and `joinRoom` to seat the leaf). Generate two colliding proofs for that identity; pass their `(x,y)` to `banOnCollision`; assert `banned:true`, the membership is now `BANNED`, all its leaves are pruned, and a `Ban` row exists with `reason=RATE_LIMIT_COLLISION` and the recovered `shamirSecret`. Also assert a subsequent `joinRoom` for that membership returns `banned`.

- [ ] **Step 3:** test green; typecheck clean. Commit:
```bash
git add services/api/src/messaging/ban.ts services/api/src/messaging/ban.test.ts
git commit -m "Implement rate-limit ban via Shamir recovery"
```

---

## Task 4: Pipeline + persistence + Redis broadcast + message.send

**Files:** `services/api/src/realtime/redis.ts`, `services/api/src/realtime/broadcast.ts`, `services/api/src/messaging/pipeline.ts`(+test), `services/api/src/trpc/message.router.ts`, modify `trpc/app.router.ts`. Add `ioredis` dep.

- [ ] **Step 1:** `pnpm add ioredis --filter @discreetly/api`.

- [ ] **Step 2: `realtime/redis.ts`** — lazy ioredis clients (one for publish, one per subscriber):
```ts
import Redis from 'ioredis';
import { getConfig } from '../config.js';

let pub: Redis | undefined;
export function publisher(): Redis {
  return (pub ??= new Redis(getConfig().REDIS_URL));
}
export function makeSubscriber(): Redis {
  return new Redis(getConfig().REDIS_URL);
}
export const roomChannel = (roomId: string): string => `room:${roomId}`;
```

- [ ] **Step 3: `realtime/broadcast.ts`** — publish a broadcast message + an async iterator of a room's messages:
```ts
import { publisher, makeSubscriber, roomChannel } from './redis.js';

export interface BroadcastMessage {
  id: string; roomId: string; epoch: string; content: string; sessionColor?: string; createdAt: string;
}

export async function publishMessage(msg: BroadcastMessage): Promise<void> {
  await publisher().publish(roomChannel(msg.roomId), JSON.stringify(msg));
}

/** Async iterator yielding messages published to a room. Caller aborts via signal. */
export async function* roomMessages(roomId: string, signal: AbortSignal): AsyncGenerator<BroadcastMessage> {
  const sub = makeSubscriber();
  const queue: BroadcastMessage[] = [];
  let resolve: (() => void) | undefined;
  sub.on('message', (_ch, payload) => {
    queue.push(JSON.parse(payload) as BroadcastMessage);
    resolve?.();
  });
  await sub.subscribe(roomChannel(roomId));
  try {
    while (!signal.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((r) => {
          resolve = r;
          signal.addEventListener('abort', () => r(), { once: true });
        });
        resolve = undefined;
      }
      while (queue.length) yield queue.shift()!;
    }
  } finally {
    await sub.quit();
  }
}
```

- [ ] **Step 4: `messaging/pipeline.ts`** — the orchestrator tying verify → collision/ban → persist → publish:
```ts
import { prisma } from '@discreetly/db';
import type { RLNFullProof } from 'rlnjs';
import { verifyMessage } from './verify-message.js';
import { checkCollision } from './collision.js';
import { banOnCollision } from './ban.js';
import { publishMessage, type BroadcastMessage } from '../realtime/broadcast.js';

export interface SendInput {
  roomId: string; content: string; proof: RLNFullProof; sessionColor?: string;
}

export type SendResult =
  | { status: 'sent'; message: BroadcastMessage }
  | { status: 'duplicate' }
  | { status: 'banned' }                              // this message triggered (or hit) a ban
  | { status: 'rejected'; reason: string };

export async function sendMessage(input: SendInput): Promise<SendResult> {
  const room = await prisma.room.findUnique({ where: { id: input.roomId } });
  if (!room) return { status: 'rejected', reason: 'no-room' };

  const leaves = (await prisma.membershipLeaf.findMany({
    where: { roomId: room.id, revokedAt: null }, select: { rateCommitment: true },
  })).map((l) => l.rateCommitment);

  const currentEpoch = BigInt(Math.floor(Date.now() / room.rateLimit));
  const verified = await verifyMessage({
    rlnIdentifier: BigInt(room.rlnIdentifier), proof: input.proof, content: input.content, leaves, currentEpoch,
  });
  if (!verified.ok) return { status: 'rejected', reason: verified.reason };

  const collision = await checkCollision({ roomId: room.id, epoch: verified.epoch, nullifier: verified.nullifier, x: verified.x });
  if (collision.kind === 'duplicate') return { status: 'duplicate' };
  if (collision.kind === 'collision') {
    await banOnCollision({
      roomId: room.id, userMessageLimit: room.userMessageLimit,
      x1: collision.prior.x, y1: collision.prior.y, x2: verified.x, y2: verified.y,
    });
    return { status: 'banned' };
  }

  const stored = await prisma.message.create({
    data: {
      roomId: room.id, epoch: verified.epoch, rlnNullifier: verified.nullifier,
      content: input.content, proof: input.proof as unknown as object, sessionColor: input.sessionColor,
    },
  });
  const message: BroadcastMessage = {
    id: stored.id, roomId: room.id, epoch: verified.epoch.toString(),
    content: input.content, sessionColor: input.sessionColor ?? undefined, createdAt: stored.createdAt.toISOString(),
  };
  await publishMessage(message);
  return { status: 'sent', message };
}
```
(Note: collision detection relies on the `@@unique([roomId, epoch, rlnNullifier])` constraint as a backstop — if two non-duplicate messages race the same nullifier, the second `message.create` throws P2002; wrap the create in try/catch and, on P2002, re-run `checkCollision` to handle it as a collision. Implement that backstop.)

- [ ] **Step 5: `message.router.ts`** — `send` mutation (+ `subscribe` stub wired in T5):
```ts
import { z } from 'zod';
import { router, publicProcedure } from './trpc.js';
import { sendMessage } from '../messaging/pipeline.js';
import type { RLNFullProof } from 'rlnjs';

export const messageRouter = router({
  send: publicProcedure
    .input(z.object({ roomId: z.string(), content: z.string(), proof: z.unknown(), sessionColor: z.string().optional() }))
    .mutation(async ({ input }) => sendMessage({
      roomId: input.roomId, content: input.content, proof: input.proof as RLNFullProof, sessionColor: input.sessionColor,
    })),
});
```
Mount it in `app.router.ts` as `message: messageRouter`.

- [ ] **Step 6: `pipeline.test.ts`** — integration end-to-end against real DB + Redis (Redis is running on 6379): seat a membership leaf, send a valid message → `sent` (and a `message.create` row exists); send the same content again (same proof) → `duplicate`; send a second DIFFERENT message with a colliding proof (same epoch/messageId) → `banned`, membership BANNED, leaves pruned. Assert `publishMessage` delivered (subscribe via `roomMessages` with a short AbortController before sending, collect the first message).

- [ ] **Step 7:** test green; typecheck clean. Commit:
```bash
git add services/api/src/realtime services/api/src/messaging/pipeline.ts services/api/src/messaging/pipeline.test.ts services/api/src/trpc/message.router.ts services/api/src/trpc/app.router.ts services/api/package.json pnpm-lock.yaml
git commit -m "Add message pipeline, Redis broadcast, and message.send"
```

---

## Task 5: WebSocket subscription

**Files:** modify `services/api/src/trpc/message.router.ts` (add `subscribe`), `services/api/src/server.ts` (attach WS). Add `ws` + `@trpc/server` ws adapter (bundled).

- [ ] **Step 1:** `pnpm add ws --filter @discreetly/api` and `pnpm add -D @types/ws --filter @discreetly/api`.

- [ ] **Step 2: add `subscribe`** to `message.router.ts` using tRPC v11 subscriptions (async generator):
```ts
  subscribe: publicProcedure
    .input(z.object({ roomId: z.string() }))
    .subscription(async function* ({ input, signal }) {
      const { roomMessages } = await import('../realtime/broadcast.js');
      yield* roomMessages(input.roomId, signal!);
    }),
```
(tRPC v11 supports async-generator subscriptions with an AbortSignal; adjust to the exact v11 API from `@trpc/server` types if the signature differs.)

- [ ] **Step 3: attach a WS server** in `server.ts`:
```ts
import { WebSocketServer } from 'ws';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
// after createHTTPServer(...) -> `const server = ...`:
const wss = new WebSocketServer({ server: server.server }); // standalone adapter exposes .server
applyWSSHandler({ wss, router: appRouter, createContext: () => ({ verify: getProductionVerifier() }) });
```
(Confirm how the standalone adapter exposes the underlying http.Server; if it doesn't, create the WS server on a separate port `API_PORT+1` and log it. Pick whichever the installed adapters support cleanly.)

- [ ] **Step 4: subscription integration test** `services/api/src/trpc/message.subscribe.test.ts` — start the server (or call the subscription resolver directly with a mock AbortSignal), publish a message via the pipeline, assert the subscriber receives it. A direct-resolver test (no real socket) is acceptable: drive `roomMessages` + `publishMessage` and assert delivery (this already happens in T4's pipeline test; here assert the tRPC `subscribe` procedure yields it). Keep it deterministic with an AbortController timeout.

- [ ] **Step 5:** test green; typecheck clean; boot smoke (start server, open a ws to `message.subscribe`, publish, receive, close) OR rely on the resolver test. Commit:
```bash
git add services/api/src/trpc/message.router.ts services/api/src/trpc/message.subscribe.test.ts services/api/src/server.ts services/api/package.json pnpm-lock.yaml
git commit -m "Add message.subscribe over WebSocket"
```

---

## Task 6: Workspace verification + review + merge

- [ ] **Step 1:** `pnpm install`; `pnpm typecheck` (all clean); `pnpm test` (all packages green; api includes messaging/ban/pipeline; live Minister test skips if down); `pnpm format` (idempotent).
- [ ] **Step 2:** Holistic adversarial review (dimensions: RLN-verify/epoch-binding soundness, ban correctness + concurrency, realtime/pub-sub + subscription lifecycle/leaks). Act on confirmed findings.
- [ ] **Step 3:** Merge `feat/v2-messaging` → `main` via superpowers:finishing-a-development-branch; verify merged main; clean up the worktree.

## Self-Review Notes (spec coverage)
- §9 send message (RLN verify → collision → ban) → T2, T3, T4. Epoch bound to proof (3b-prep #3a) → T2. `verifyRLNProof` throw handled → T2.
- §9 ban (Shamir → recover → prune all leaves + banlist nullifier) → T3.
- §10 realtime (Redis pub/sub + WS subscriptions) → T4, T5.
- 3a-deferred cleanups (lazy config, crypto subpath) → T1.
- **Deferred to 3c:** admin (room CRUD, policy authoring, ban-by-IC/nullifier, unban, audit). **Plan 4:** frontend prover + chat UI + full Playwright e2e.
- **Ephemeral rooms:** this plan persists all rooms to the DB. In-memory ephemeral message storage (no DB) + epoch GC is deferred — add it in 3c or a 3b follow-up if `persistence: EPHEMERAL` rooms are needed before Plan 4.
```
