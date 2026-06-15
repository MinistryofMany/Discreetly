# Discreetly v2 — Backend 3a: Minister Gate + Membership

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stand up `services/api` (the long-lived backend) far enough to gate room access via Minister OIDC: verify a Minister id_token + its badge VCs against the (configurable) live JWKS, evaluate the room's boolean policy, derive the join-nullifier, and create/rotate the multi-device membership. tRPC procedures for room read + membership join/rotate/add-device.

**Architecture:** `services/api` is a Node tRPC server (standalone HTTP adapter in 3a; WebSocket subscriptions added in 3b for messaging). It consumes `@discreetly/db`, `@discreetly/crypto`, `@discreetly/policy`, `@discreetly/shared`. The Minister provider's issuer URL, JWKS URL, expected VC issuer (`did:web`), and our client_id are all **env-configurable** — the provider is being renamed Tessera→**Minister**, so nothing about its identity is hardcoded. The backend trusts a valid Minister-signed id_token presented by the Next frontend's server (the raw id_token never reaches the browser).

**Tech stack:** `@trpc/server@^11`, `zod@^3.24`, `jose@^5.9`, plus the workspace packages. Node 20, TypeScript strict.

**Reference:** spec `docs/superpowers/specs/2026-06-12-discreetly-tessera-gating-design.md` (§6 auth/gate, §7 policy, §8 data model, §9 join/rotate). Crypto-integration follow-ups: `docs/superpowers/notes/2026-06-13-plan3-crypto-integration.md`.

## Proven Minister facts (verified live; all env-configurable)

| Thing                               | Current value (dev)                           | Env var              |
| ----------------------------------- | --------------------------------------------- | -------------------- |
| OIDC issuer (`iss` of id_token)     | `http://localhost:3000`                       | `MINISTER_ISSUER`    |
| JWKS URL                            | `http://localhost:3000/.well-known/jwks.json` | `MINISTER_JWKS_URL`  |
| VC issuer (`iss` of each VC)        | `did:web:tessera.local`                       | `MINISTER_VC_ISSUER` |
| Our OIDC client_id (id_token `aud`) | `discreetly_dev`                              | `MINISTER_CLIENT_ID` |
| Signing alg                         | EdDSA (Ed25519)                               | —                    |

- **id_token claims:** `iss`, `sub` (pairwise, base64url string), `aud`, `iat`, `exp`, `nonce`, optional `name`/`picture`, `tessera_badges` (array of VC JWT strings).
- **Each badge VC (JWT):** header `{alg:"EdDSA", kid:"did:web:tessera.local#key-1", typ:"vc+jwt"}`; payload `{iss:"did:web:tessera.local", sub:"did:web:tessera.local:users:<id>", iat, exp, jti, vc:{ "@context":[…], type:["VerifiableCredential","Tessera<Pascal>Credential"], credentialSubject:{ id, …attrs } }}`.
- **Badge-type mapping:** `vc.type[1]` `"TesseraEmailDomainCredential"` → policy badge type `"email-domain"` (strip `Tessera`/`Credential`, PascalCase→kebab).
- **Live interop recipe (for the interop test):** insert an `OidcAuthorizationCode` row into Minister's dev DB (`postgresql://tessera:tessera@localhost:5433/tessera`) with `approvedBadgeIds`, then `POST http://localhost:3000/oidc/token` with PKCE → real id_token. Proven working. The dev DB already has user `tyler-demo@tessera.test` with an `email-domain` badge (`domain: heart.engineering`).

## File structure (created by this plan)

```
services/api/
├── package.json                 # @discreetly/api
├── tsconfig.json                # consumer of @discreetly/crypto (see Task 1)
├── vitest.config.ts
├── .env.example                 # MINISTER_* + DATABASE_URL
└── src/
    ├── config.ts                # env config (zod-validated)
    ├── config.test.ts
    ├── minister/
    │   ├── verify.ts            # verifyMinisterIdToken -> { sub, badges: VerifiedBadge[] }
    │   ├── badge-type.ts        # credentialTypeToBadgeType
    │   ├── badge-type.test.ts
    │   └── verify.test.ts       # mock-issuer + (gated) live-interop
    ├── gate/
    │   ├── join-nullifier.ts    # joinNullifier(sub, rlnIdentifier)
    │   ├── join-nullifier.test.ts
    │   ├── gate.ts              # evaluate room policy against verified badges
    │   └── gate.test.ts
    ├── membership/
    │   ├── membership.ts        # join / rotate / addDevice (DB writes)
    │   └── membership.test.ts
    ├── trpc/
    │   ├── trpc.ts             # initTRPC, context
    │   ├── room.router.ts
    │   ├── membership.router.ts
    │   └── app.router.ts        # AppRouter (exported type)
    ├── server.ts               # standalone HTTP tRPC server
    └── test/
        ├── mock-issuer.ts      # Ed25519 keypair + sign id_tokens/VCs + in-memory JWKS
        └── minister-live.ts    # helper: obtain a real token via the dev-DB grant (gated)
packages/crypto/src/rln/merkle.ts   # ADD computeRoot() (Task 1)
packages/db/prisma/schema.prisma     # ADD Ban indexes (Task 2)
```

---

## Task 1: Make `@discreetly/crypto` cleanly consumable + add `computeRoot`

The crypto package leaks the `@semaphore-protocol` `Group` type and relies on a local `ffjavascript` ambient that doesn't transit to consumers (see the crypto-integration note). Fix both centrally so `services/api` (and Plan 4's frontend) can import crypto without TS7016.

**Files:** `packages/crypto/src/rln/merkle.ts` (modify), `packages/crypto/src/rln/merkle.test.ts` (modify), `packages/shared/src/types/external-shims.d.ts` (create), `packages/shared/package.json` (modify), `packages/crypto/tsconfig.json` (modify), `packages/shared/src/index.ts` (verify).

- [ ] **Step 1: Add `computeRoot` so consumers needn't touch the `Group` type.** Append to `packages/crypto/src/rln/merkle.ts`:

```ts
/** The Merkle root of the room's leaf set, as a bigint (no Group type leak). */
export function computeRoot(rlnIdentifier: bigint, leaves: readonly (string | bigint)[]): bigint {
  return BigInt(buildGroup(rlnIdentifier, leaves).root);
}
```

- [ ] **Step 2: Test it.** Add to `packages/crypto/src/rln/merkle.test.ts` (create the file if it does not exist, importing from `./merkle.js`):

```ts
import { describe, it, expect } from 'vitest';
import { computeRoot, buildGroup } from './merkle.js';

describe('computeRoot', () => {
  it('equals the group root as a bigint', () => {
    const leaves = [111n, 222n, 333n];
    expect(computeRoot(99n, leaves)).toBe(BigInt(buildGroup(99n, leaves).root));
  });
  it('is order-sensitive and deterministic', () => {
    expect(computeRoot(1n, [1n, 2n])).toBe(computeRoot(1n, [1n, 2n]));
    expect(computeRoot(1n, [1n, 2n])).not.toBe(computeRoot(1n, [2n, 1n]));
  });
});
```

Run: `pnpm --filter @discreetly/crypto exec vitest run src/rln/merkle.test.ts` → PASS.

- [ ] **Step 3: Create a shared ambient-shim file** consumers can reference. `packages/shared/src/types/external-shims.d.ts`:

```ts
// Ambient module declarations for crypto deps that ship runtime code but no
// resolvable types under moduleResolution:"Bundler" (their package.json exports
// maps omit a "types" condition). Consumers of @discreetly/crypto reference this
// via a triple-slash directive in their tsconfig include.
declare module 'ffjavascript' {
  export class ZqField {
    constructor(p: bigint);
    add(a: bigint, b: bigint): bigint;
    sub(a: bigint, b: bigint): bigint;
    mul(a: bigint, b: bigint): bigint;
    div(a: bigint, b: bigint): bigint;
    normalize(a: bigint): bigint;
  }
}
```

Add to `packages/shared/package.json` `exports` so consumers can locate it:

```jsonc
"exports": {
  ".": "./src/index.ts",
  "./types/external-shims.d.ts": "./src/types/external-shims.d.ts"
}
```

(Keep the existing `.` export; add the second entry. `main`/`types` stay `./src/index.ts`.)

- [ ] **Step 4: Point crypto at the shared shim** instead of its local one (single source of truth). In `packages/crypto/tsconfig.json`, keep the existing `@semaphore-protocol/*` `paths`, and ensure `ffjavascript` resolves via the shared shim by adding it to `include`:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"],
    "paths": {
      "@semaphore-protocol/group": [
        "./node_modules/@semaphore-protocol/group/dist/types/index.d.ts",
      ],
      "@semaphore-protocol/identity": [
        "./node_modules/@semaphore-protocol/identity/dist/types/index.d.ts",
      ],
    },
  },
  "include": ["src", "../shared/src/types/external-shims.d.ts"],
}
```

Then delete `packages/crypto/src/types/ffjavascript.d.ts` (now redundant) and confirm `pnpm --filter @discreetly/crypto typecheck` still passes.

- [ ] **Step 5: Document the consumer pattern.** This is what `services/api` (Task 3) and Plan 4's app will replicate in their tsconfig: the `@semaphore-protocol` `paths` (only if they import `buildGroup`/`merkleProofForLeaf`; verify-only consumers using `computeRoot`/`verifyRLNProof`/`shamirRecovery` need only the ffjavascript shim) plus `"../shared/src/types/external-shims.d.ts"` in `include`. Note it in `docs/superpowers/notes/2026-06-13-plan3-crypto-integration.md` (append a "Resolved in 3a" line).

- [ ] **Step 6: Commit**

```bash
git add packages/crypto packages/shared docs/superpowers/notes
git commit -m "Add computeRoot and shared ambient shims for crypto consumers"
```

---

## Task 2: Schema additions for the gate + ban (deferred from Plan 1)

**Files:** `packages/db/prisma/schema.prisma` (modify), new migration, `packages/db/src/smoke.test.ts` (add a ban-index smoke assertion is optional — at minimum migrate cleanly).

- [ ] **Step 1: Add a `rateCommitment` ban index** (the message/ban path queries bans; join queries by `joinNullifier` which is already indexed). In `schema.prisma`, change the `Ban` model's index block to:

```prisma
@@index([roomId, joinNullifier])
@@index([roomId, rateCommitment])
```

- [ ] **Step 2: Add audit-query indexes** to `AuditLog`:

```prisma
@@index([createdAt])
@@index([actor])
@@index([action])
```

- [ ] **Step 3: Create the migration** (Postgres + Redis are running on 5432/6379; `.env` has `DATABASE_URL`):

Run: `pnpm --filter @discreetly/db exec dotenv -e ../../.env -- prisma migrate dev --name gate_indexes`
Expected: a new migration under `packages/db/prisma/migrations/`, applied cleanly.

- [ ] **Step 4: Validate + smoke** `pnpm --filter @discreetly/db validate` and `pnpm --filter @discreetly/db test` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "Add Ban rateCommitment + AuditLog query indexes"
```

---

## Task 3: `@discreetly/api` scaffold + config

**Files:** `services/api/package.json`, `services/api/tsconfig.json`, `services/api/vitest.config.ts`, `services/api/.env.example`, `services/api/src/config.ts`, `services/api/src/config.test.ts`.

- [ ] **Step 1: `services/api/package.json`:**

```json
{
  "name": "@discreetly/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/server.ts",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "typecheck": "tsc --noEmit",
    "lint": "echo \"(no lint configured)\"",
    "test": "dotenv -e ../../.env -- vitest run"
  },
  "dependencies": {
    "@discreetly/crypto": "workspace:*",
    "@discreetly/db": "workspace:*",
    "@discreetly/policy": "workspace:*",
    "@discreetly/shared": "workspace:*",
    "@trpc/server": "^11.0.0",
    "jose": "^5.9.6",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "dotenv-cli": "^7.4.4",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: `services/api/tsconfig.json`** (replicate the crypto-consumer pattern from Task 1; this package uses `computeRoot`/`verifyRLNProof`/`shamirRecovery`, i.e. needs the ffjavascript shim, and does NOT import `buildGroup` directly so no semaphore paths needed):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src", "../../packages/shared/src/types/external-shims.d.ts"]
}
```

- [ ] **Step 3: `services/api/vitest.config.ts`:**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], testTimeout: 30_000 },
});
```

- [ ] **Step 4: `services/api/.env.example`** (the root `.env` is what tests load; document the keys):

```
DATABASE_URL="postgresql://discreetly:discreetly@localhost:5432/discreetly?schema=public"
REDIS_URL="redis://localhost:6379"
MINISTER_ISSUER="http://localhost:3000"
MINISTER_JWKS_URL="http://localhost:3000/.well-known/jwks.json"
MINISTER_VC_ISSUER="did:web:tessera.local"
MINISTER_CLIENT_ID="discreetly_dev"
API_PORT="3002"
```

Append these `MINISTER_*` + `API_PORT` keys to the repo-root `.env` and `.env.example` as well (so tests and dev have them).

- [ ] **Step 5: `services/api/src/config.ts`** (zod-validated, overridable for tests):

```ts
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  MINISTER_ISSUER: z.string().url(),
  MINISTER_JWKS_URL: z.string().url(),
  MINISTER_VC_ISSUER: z.string().min(1),
  MINISTER_CLIENT_ID: z.string().min(1),
  API_PORT: z.coerce.number().default(3002),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}

export const config: Config = loadConfig();
```

- [ ] **Step 6: `services/api/src/config.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
      MINISTER_ISSUER: 'http://localhost:3000',
      MINISTER_JWKS_URL: 'http://localhost:3000/.well-known/jwks.json',
      MINISTER_VC_ISSUER: 'did:web:tessera.local',
      MINISTER_CLIENT_ID: 'discreetly_dev',
    } as NodeJS.ProcessEnv);
    expect(c.API_PORT).toBe(3002);
    expect(c.MINISTER_CLIENT_ID).toBe('discreetly_dev');
  });
  it('rejects a missing issuer', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://u:p@h:5432/d' } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
```

- [ ] **Step 7:** `pnpm install`; `pnpm --filter @discreetly/api test` (config tests pass); `pnpm --filter @discreetly/api typecheck` clean. Commit:

```bash
git add services/api pnpm-lock.yaml .env.example
git commit -m "Scaffold @discreetly/api with validated config"
```

---

## Task 4: Badge-type mapping (TDD)

**Files:** `services/api/src/minister/badge-type.ts`, `services/api/src/minister/badge-type.test.ts`.

- [ ] **Step 1: Failing test** `badge-type.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { credentialTypeToBadgeType } from './badge-type.js';

describe('credentialTypeToBadgeType', () => {
  it('maps Tessera credential types to policy badge types', () => {
    expect(
      credentialTypeToBadgeType(['VerifiableCredential', 'TesseraEmailDomainCredential']),
    ).toBe('email-domain');
    expect(
      credentialTypeToBadgeType(['VerifiableCredential', 'TesseraOauthAccountCredential']),
    ).toBe('oauth-account');
    expect(credentialTypeToBadgeType(['VerifiableCredential', 'TesseraInviteCodeCredential'])).toBe(
      'invite-code',
    );
    expect(credentialTypeToBadgeType(['VerifiableCredential', 'TesseraAgeOver21Credential'])).toBe(
      'age-over-21',
    );
  });
  it('returns null for unrecognized shapes', () => {
    expect(credentialTypeToBadgeType(['VerifiableCredential'])).toBeNull();
    expect(credentialTypeToBadgeType(['VerifiableCredential', 'SomethingElse'])).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `badge-type.ts`:

```ts
const TESSERA_CRED = /^Tessera(.+)Credential$/;

/** Map a VC `type` array to the policy badge-type string, or null if unrecognized. */
export function credentialTypeToBadgeType(vcTypes: readonly string[]): string | null {
  const specific = vcTypes.find((t) => t !== 'VerifiableCredential');
  if (!specific) return null;
  const m = TESSERA_CRED.exec(specific);
  if (!m) return null;
  // PascalCase/alphanumerics -> kebab: EmailDomain->email-domain, AgeOver21->age-over-21
  return m[1]
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])([0-9])/g, '$1-$2')
    .toLowerCase();
}
```

- [ ] **Step 4: Run → PASS. Commit:**

```bash
git add services/api/src/minister/badge-type.ts services/api/src/minister/badge-type.test.ts
git commit -m "Add Minister VC type -> badge type mapping"
```

---

## Task 5: Minister id_token + VC verification (mock-issuer TDD + live interop)

**Files:** `services/api/src/test/mock-issuer.ts`, `services/api/src/minister/verify.ts`, `services/api/src/minister/verify.test.ts`.

- [ ] **Step 1: Build the mock issuer** `services/api/src/test/mock-issuer.ts` — an Ed25519 keypair + helpers to sign id_tokens and VCs in Minister's exact shape, plus an in-memory JWKS the verifier can be pointed at:

```ts
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

const KID = 'did:web:mock.minister#key-1';
export const MOCK_VC_ISSUER = 'did:web:mock.minister';
export const MOCK_ISSUER = 'https://mock.minister';
export const MOCK_CLIENT_ID = 'discreetly_test';

const { publicKey, privateKey } = await generateKeyPair('EdDSA');

export async function jwks(): Promise<{ keys: JWK[] }> {
  const jwk = await exportJWK(publicKey);
  return { keys: [{ ...jwk, alg: 'EdDSA', use: 'sig', kid: KID }] };
}

export interface MockBadge {
  type: string; // policy badge type, e.g. "email-domain"
  attributes: Record<string, string | number | boolean>;
  ageDays?: number; // how long ago issued (for expiry tests); default 0
}

function badgeTypeToCredType(type: string): string {
  const pascal = type
    .split('-')
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('');
  return `Tessera${pascal}Credential`;
}

async function signVc(userId: string, badge: MockBadge): Promise<string> {
  const iatSec = Math.floor(Date.now() / 1000) - (badge.ageDays ?? 0) * 86_400;
  return new SignJWT({
    vc: {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', badgeTypeToCredType(badge.type)],
      credentialSubject: { id: `${MOCK_VC_ISSUER}:users:${userId}`, ...badge.attributes },
    },
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: KID, typ: 'vc+jwt' })
    .setIssuer(MOCK_VC_ISSUER)
    .setSubject(`${MOCK_VC_ISSUER}:users:${userId}`)
    .setIssuedAt(iatSec)
    .setExpirationTime('365d')
    .sign(privateKey);
}

export async function signIdToken(opts: {
  sub: string;
  userId?: string;
  badges?: MockBadge[];
  aud?: string;
  issuer?: string;
  nonce?: string;
}): Promise<string> {
  const userId = opts.userId ?? 'mockuser';
  const tessera_badges = await Promise.all((opts.badges ?? []).map((b) => signVc(userId, b)));
  return new SignJWT({ nonce: opts.nonce ?? 'n', tessera_badges })
    .setProtectedHeader({ alg: 'EdDSA', kid: KID, typ: 'JWT' })
    .setIssuer(opts.issuer ?? MOCK_ISSUER)
    .setSubject(opts.sub)
    .setAudience(opts.aud ?? MOCK_CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}
```

- [ ] **Step 2: Write the failing verify test** `services/api/src/minister/verify.test.ts`. Inject the mock JWKS + issuer config via a factory (so we don't depend on the live provider for unit tests):

```ts
import { describe, it, expect } from 'vitest';
import { createLocalJWKSet } from 'jose';
import { makeVerifier } from './verify.js';
import {
  jwks,
  signIdToken,
  MOCK_ISSUER,
  MOCK_VC_ISSUER,
  MOCK_CLIENT_ID,
} from '../test/mock-issuer.js';

const verify = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  vcIssuer: MOCK_VC_ISSUER,
  jwks: createLocalJWKSet(await jwks()),
});

describe('verifyMinisterIdToken (mock issuer)', () => {
  it('verifies a token and extracts verified badges', async () => {
    const idToken = await signIdToken({
      sub: 'pairwise-abc',
      badges: [{ type: 'email-domain', attributes: { domain: 'acme.com' } }],
    });
    const result = await verify(idToken);
    expect(result.sub).toBe('pairwise-abc');
    expect(result.badges).toEqual([
      expect.objectContaining({ type: 'email-domain', attributes: { domain: 'acme.com' } }),
    ]);
    expect(typeof result.badges[0]!.issuedAt).toBe('number');
  });

  it('rejects a wrong audience', async () => {
    const idToken = await signIdToken({ sub: 's', aud: 'someone-else' });
    await expect(verify(idToken)).rejects.toThrow();
  });

  it('rejects a wrong issuer', async () => {
    const idToken = await signIdToken({ sub: 's', issuer: 'https://evil' });
    await expect(verify(idToken)).rejects.toThrow();
  });

  it('rejects a VC with an unexpected issuer', async () => {
    // hand-craft is unnecessary: a VC always uses MOCK_VC_ISSUER here, so
    // instead point the verifier at a different expected vcIssuer.
    const v = makeVerifier({
      issuer: MOCK_ISSUER,
      audience: MOCK_CLIENT_ID,
      vcIssuer: 'did:web:other',
      jwks: createLocalJWKSet(await jwks()),
    });
    const idToken = await signIdToken({
      sub: 's',
      badges: [{ type: 'email-domain', attributes: { domain: 'a.com' } }],
    });
    await expect(v(idToken)).rejects.toThrow();
  });

  it('returns an empty badge set when none are disclosed', async () => {
    const idToken = await signIdToken({ sub: 's' });
    expect((await verify(idToken)).badges).toEqual([]);
  });
});
```

- [ ] **Step 3: Run → FAIL.**

- [ ] **Step 4: Implement** `services/api/src/minister/verify.ts`:

```ts
import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { VerifiedBadge } from '@discreetly/policy';
import { config } from '../config.js';
import { credentialTypeToBadgeType } from './badge-type.js';

export interface VerifiedIdentity {
  sub: string;
  badges: VerifiedBadge[];
}

interface VerifierDeps {
  issuer: string;
  audience: string;
  vcIssuer: string;
  jwks: JWTVerifyGetKey;
}

interface VcBody {
  type?: string[];
  credentialSubject?: Record<string, unknown>;
}

/** Factory so tests can inject a local JWKS + mock issuer config. */
export function makeVerifier(deps: VerifierDeps) {
  return async function verifyMinisterIdToken(idToken: string): Promise<VerifiedIdentity> {
    const { payload } = await jwtVerify(idToken, deps.jwks, {
      issuer: deps.issuer,
      audience: deps.audience,
    });
    const sub = payload.sub;
    if (!sub) throw new Error('id_token missing sub');

    const raw = Array.isArray(payload.tessera_badges) ? payload.tessera_badges : [];
    const badges: VerifiedBadge[] = [];
    for (const vcJwt of raw) {
      if (typeof vcJwt !== 'string') throw new Error('non-string badge entry');
      const { payload: vc } = await jwtVerify(vcJwt, deps.jwks); // signature + exp
      if (vc.iss !== deps.vcIssuer) throw new Error(`unexpected VC issuer: ${String(vc.iss)}`);
      const body = vc.vc as VcBody | undefined;
      if (!body?.type || !body.credentialSubject) throw new Error('malformed VC');
      const type = credentialTypeToBadgeType(body.type);
      if (!type) throw new Error(`unrecognized VC type: ${JSON.stringify(body.type)}`);
      const { id: _id, ...attributes } = body.credentialSubject;
      badges.push({
        type,
        attributes: attributes as VerifiedBadge['attributes'],
        issuedAt: typeof vc.iat === 'number' ? vc.iat : 0,
      });
    }
    return { sub, badges };
  };
}

/** Production verifier bound to the configured live Minister JWKS. */
export const verifyMinisterIdToken = makeVerifier({
  issuer: config.MINISTER_ISSUER,
  audience: config.MINISTER_CLIENT_ID,
  vcIssuer: config.MINISTER_VC_ISSUER,
  jwks: createRemoteJWKSet(new URL(config.MINISTER_JWKS_URL)),
});
```

- [ ] **Step 5: Run → PASS** (`pnpm --filter @discreetly/api exec vitest run src/minister/verify.test.ts`).

- [ ] **Step 6: Live-interop test** `services/api/src/minister/verify.live.test.ts` — gated so it only runs when the live Minister is reachable. It obtains a REAL token via the dev-DB grant and confirms the production verifier accepts it. Create `services/api/src/test/minister-live.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';

const DEV_DB = 'postgresql://tessera:tessera@localhost:5433/tessera?schema=public';
const REDIRECT = 'http://localhost:3001/api/auth/callback/minister';
const b64url = (b: Buffer) => b.toString('base64url');

/**
 * Obtain a REAL Minister id_token for the seeded dev user + their email-domain
 * badge, by inserting a consent (OidcAuthorizationCode) row directly and
 * exchanging it at the live /oidc/token. Returns null if the live provider or
 * dev DB is unreachable (caller should skip).
 */
export async function getRealMinisterIdToken(): Promise<string | null> {
  let pg: typeof import('pg');
  try {
    pg = await import('pg');
  } catch {
    return null; // pg not installed; skip live test
  }
  const client = new pg.Client({ connectionString: DEV_DB });
  try {
    await client.connect();
  } catch {
    return null;
  }
  try {
    const user = (await client.query('select id from "User" limit 1')).rows[0];
    const badge = (await client.query(`select id from "Badge" where type='email-domain' limit 1`))
      .rows[0];
    if (!user || !badge) return null;

    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const code = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(16));
    await client.query(
      `insert into "OidcAuthorizationCode"
       (code,"clientId","userId","redirectUri",scopes,"approvedBadgeIds",nonce,"codeChallenge","codeChallengeMethod","expiresAt")
       values ($1,'discreetly_dev',$2,$3,$4,$5,$6,$7,'S256', now() + interval '60 seconds')`,
      [
        code,
        user.id,
        REDIRECT,
        ['openid', 'profile', 'badge:email-domain'],
        [badge.id],
        nonce,
        challenge,
      ],
    );

    const res = await fetch('http://localhost:3000/oidc/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: 'discreetly_dev',
        client_secret: process.env.MINISTER_CLIENT_SECRET ?? 'discreetly_dev_secret_2026',
        code_verifier: verifier,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { id_token?: string };
    return json.id_token ?? null;
  } finally {
    await client.end();
  }
}
```

Add `pg` + `@types/pg` to `services/api` devDependencies (`pnpm add -D pg @types/pg --filter @discreetly/api`). Then `services/api/src/minister/verify.live.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { verifyMinisterIdToken } from './verify.js';
import { getRealMinisterIdToken } from '../test/minister-live.js';

const idToken = await getRealMinisterIdToken();

describe.skipIf(!idToken)('verifyMinisterIdToken (LIVE Minister)', () => {
  it('verifies a real id_token + email-domain VC against the live JWKS', async () => {
    const result = await verifyMinisterIdToken(idToken!);
    expect(result.sub).toBeTruthy();
    const emailBadge = result.badges.find((b) => b.type === 'email-domain');
    expect(emailBadge).toBeTruthy();
    expect(typeof emailBadge!.attributes.domain).toBe('string');
  });
});
```

This requires the root `.env` `MINISTER_*` to match the live provider (issuer `http://localhost:3000`, vcIssuer `did:web:tessera.local`, client_id `discreetly_dev`). Run with the live Minister up: `pnpm --filter @discreetly/api test` → the live test runs and passes; with Minister down it cleanly skips.

- [ ] **Step 7: Commit**

```bash
git add services/api/src/minister services/api/src/test pnpm-lock.yaml
git commit -m "Add Minister id_token + VC verification with mock-issuer and live-interop tests"
```

---

## Task 6: join-nullifier + gate (TDD)

**Files:** `services/api/src/gate/join-nullifier.ts`(+test), `services/api/src/gate/gate.ts`(+test).

- [ ] **Step 1: join-nullifier test** `join-nullifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { joinNullifier } from './join-nullifier.js';

describe('joinNullifier', () => {
  it('is deterministic per (sub, room) and field-bounded', () => {
    const FIELD = BigInt(
      '21888242871839275222246405745257275088548364400416034343698204186575808495617',
    );
    const a = joinNullifier('sub-abc', 700n);
    expect(joinNullifier('sub-abc', 700n)).toBe(a);
    expect(a).toBeLessThan(FIELD);
  });
  it('differs across subs and across rooms (per-room unlinkable)', () => {
    expect(joinNullifier('sub-a', 700n)).not.toBe(joinNullifier('sub-b', 700n));
    expect(joinNullifier('sub-a', 700n)).not.toBe(joinNullifier('sub-a', 701n));
  });
});
```

- [ ] **Step 2: Run → FAIL. Implement** `join-nullifier.ts`:

```ts
import { poseidon2 } from 'poseidon-lite';

const FIELD = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

/** Reduce an arbitrary string (e.g. the pairwise sub) to a field element. */
function toField(s: string): bigint {
  let acc = 0n;
  for (const byte of new TextEncoder().encode(s)) acc = (acc * 256n + BigInt(byte)) % FIELD;
  return acc;
}

/**
 * Per-room nullifier anchoring a Minister identity to a room.
 * Stable for (sub, room); unlinkable across rooms. ZK-friendly (Poseidon).
 */
export function joinNullifier(sub: string, rlnIdentifier: bigint): bigint {
  return poseidon2([toField(sub), rlnIdentifier % FIELD]);
}
```

- [ ] **Step 3: Run → PASS.**

- [ ] **Step 4: gate test** `gate.test.ts` — the gate ties verification + policy together. Test with the mock issuer + an in-memory policy (no DB):

```ts
import { describe, it, expect } from 'vitest';
import { createLocalJWKSet } from 'jose';
import { makeVerifier } from '../minister/verify.js';
import { evaluateGate } from './gate.js';
import {
  jwks,
  signIdToken,
  MOCK_ISSUER,
  MOCK_VC_ISSUER,
  MOCK_CLIENT_ID,
} from '../test/mock-issuer.js';
import type { PolicyNode } from '@discreetly/policy';

const verify = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  vcIssuer: MOCK_VC_ISSUER,
  jwks: createLocalJWKSet(await jwks()),
});
const policy: PolicyNode = {
  allOf: [
    { badge: { type: 'email-domain', where: { domain: 'acme.com' } } },
    { badge: { type: 'invite-code' } },
  ],
};

describe('evaluateGate', () => {
  it('passes when badges satisfy the policy and returns the join nullifier', async () => {
    const idToken = await signIdToken({
      sub: 'sub-1',
      badges: [
        { type: 'email-domain', attributes: { domain: 'acme.com' } },
        { type: 'invite-code', attributes: { label: 'x' } },
      ],
    });
    const res = await evaluateGate({
      idToken,
      rlnIdentifier: 700n,
      policy,
      verify,
      now: 1_750_000_000,
    });
    expect(res.allowed).toBe(true);
    expect(res.joinNullifier).toBeTypeOf('bigint');
    expect(res.sub).toBe('sub-1');
  });
  it('denies when a required badge is missing', async () => {
    const idToken = await signIdToken({
      sub: 'sub-2',
      badges: [{ type: 'email-domain', attributes: { domain: 'acme.com' } }],
    });
    const res = await evaluateGate({
      idToken,
      rlnIdentifier: 700n,
      policy,
      verify,
      now: 1_750_000_000,
    });
    expect(res.allowed).toBe(false);
  });
});
```

- [ ] **Step 5: Run → FAIL. Implement** `gate.ts`:

```ts
import { evaluate, type PolicyNode } from '@discreetly/policy';
import type { VerifiedIdentity } from '../minister/verify.js';
import { joinNullifier } from './join-nullifier.js';

export interface GateInput {
  idToken: string;
  rlnIdentifier: bigint;
  policy: PolicyNode;
  verify: (idToken: string) => Promise<VerifiedIdentity>;
  now?: number; // unix seconds; defaults to current time
}

export interface GateResult {
  allowed: boolean;
  sub: string;
  joinNullifier: bigint;
}

/** Verify a Minister id_token and decide room access against the room policy. */
export async function evaluateGate(input: GateInput): Promise<GateResult> {
  const { sub, badges } = await input.verify(input.idToken);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const allowed = evaluate(input.policy, badges, now);
  return { allowed, sub, joinNullifier: joinNullifier(sub, input.rlnIdentifier) };
}
```

- [ ] **Step 6: Run → PASS. Commit:**

```bash
git add services/api/src/gate
git commit -m "Add join-nullifier and policy gate"
```

---

## Task 7: Membership join / rotate / add-device (DB, integration-tested)

**Files:** `services/api/src/membership/membership.ts`(+test). Uses the real Postgres (`@discreetly/db`).

- [ ] **Step 1: Implement** `services/api/src/membership/membership.ts`:

```ts
import { prisma, MembershipStatus, type Room } from '@discreetly/db';
import { getRateCommitmentHash } from '@discreetly/crypto';

export interface JoinArgs {
  room: Pick<Room, 'id' | 'rlnIdentifier' | 'userMessageLimit' | 'maxDevices'>;
  joinNullifier: string; // decimal string of the bigint
  identityCommitment: string; // decimal string
  deviceLabel?: string;
}

export type JoinResult =
  | { ok: true; membershipId: string; leafId: string; rateCommitment: string }
  | { ok: false; reason: 'banned' | 'already-on-device' | 'device-limit' };

function rateCommitmentFor(ic: string, limit: number): string {
  return getRateCommitmentHash(BigInt(ic), limit).toString();
}

/** Join (or add a device to) a room membership. Idempotent per device leaf. */
export async function joinRoom(args: JoinArgs): Promise<JoinResult> {
  const rateCommitment = rateCommitmentFor(args.identityCommitment, args.room.userMessageLimit);
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.upsert({
      where: { roomId_joinNullifier: { roomId: args.room.id, joinNullifier: args.joinNullifier } },
      create: { roomId: args.room.id, joinNullifier: args.joinNullifier },
      update: {},
    });
    if (membership.status === MembershipStatus.BANNED)
      return { ok: false, reason: 'banned' as const };

    const existing = await tx.membershipLeaf.findUnique({
      where: { roomId_rateCommitment: { roomId: args.room.id, rateCommitment } },
    });
    if (existing) return { ok: false, reason: 'already-on-device' as const };

    const activeLeaves = await tx.membershipLeaf.count({
      where: { membershipId: membership.id, revokedAt: null },
    });
    if (activeLeaves >= args.room.maxDevices) return { ok: false, reason: 'device-limit' as const };

    const leaf = await tx.membershipLeaf.create({
      data: {
        membershipId: membership.id,
        roomId: args.room.id,
        identityCommitment: args.identityCommitment,
        rateCommitment,
        deviceLabel: args.deviceLabel,
      },
    });
    return { ok: true as const, membershipId: membership.id, leafId: leaf.id, rateCommitment };
  });
}

export interface RotateArgs {
  room: Pick<Room, 'id' | 'userMessageLimit'>;
  joinNullifier: string;
  oldIdentityCommitment: string;
  newIdentityCommitment: string;
}

export type RotateResult =
  | { ok: true; rateCommitment: string }
  | { ok: false; reason: 'banned' | 'no-membership' | 'old-leaf-not-found' };

/** Replace one device leaf's identity commitment (RLN-secret rotation). */
export async function rotateDevice(args: RotateArgs): Promise<RotateResult> {
  const oldRc = rateCommitmentFor(args.oldIdentityCommitment, args.room.userMessageLimit);
  const newRc = rateCommitmentFor(args.newIdentityCommitment, args.room.userMessageLimit);
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { roomId_joinNullifier: { roomId: args.room.id, joinNullifier: args.joinNullifier } },
    });
    if (!membership) return { ok: false, reason: 'no-membership' as const };
    if (membership.status === MembershipStatus.BANNED)
      return { ok: false, reason: 'banned' as const };

    const old = await tx.membershipLeaf.findUnique({
      where: { roomId_rateCommitment: { roomId: args.room.id, rateCommitment: oldRc } },
    });
    if (!old || old.membershipId !== membership.id)
      return { ok: false, reason: 'old-leaf-not-found' as const };

    await tx.membershipLeaf.update({
      where: { id: old.id },
      data: { identityCommitment: args.newIdentityCommitment, rateCommitment: newRc },
    });
    return { ok: true as const, rateCommitment: newRc };
  });
}
```

(`addDevice` is just `joinRoom` on an existing membership — the upsert handles both; no separate function needed.)

- [ ] **Step 2: Integration test** `membership.test.ts` (real DB; create a room in `beforeAll`, clean in `afterAll`):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, MembershipStatus } from '@discreetly/db';
import { joinRoom, rotateDevice } from './membership.js';

let room: { id: string; rlnIdentifier: string; userMessageLimit: number; maxDevices: number };

beforeAll(async () => {
  const r = await prisma.room.create({
    data: {
      name: 'Mem Test',
      slug: `mem-${Date.now()}`,
      rlnIdentifier: `rln-${Date.now()}`,
      rateLimit: 10_000,
      userMessageLimit: 5,
      maxDevices: 2,
      accessPolicy: { badge: { type: 'email-domain' } },
    },
  });
  room = {
    id: r.id,
    rlnIdentifier: r.rlnIdentifier,
    userMessageLimit: r.userMessageLimit,
    maxDevices: r.maxDevices,
  };
});
afterAll(async () => {
  await prisma.room.delete({ where: { id: room.id } });
  await prisma.$disconnect();
});

describe('membership', () => {
  it('joins, adds a second device, then enforces the device limit', async () => {
    const n = 'jn-1';
    const a = await joinRoom({
      room,
      joinNullifier: n,
      identityCommitment: '111',
      deviceLabel: 'phone',
    });
    expect(a.ok).toBe(true);
    const b = await joinRoom({
      room,
      joinNullifier: n,
      identityCommitment: '222',
      deviceLabel: 'laptop',
    });
    expect(b.ok).toBe(true);
    const c = await joinRoom({ room, joinNullifier: n, identityCommitment: '333' });
    expect(c).toMatchObject({ ok: false, reason: 'device-limit' });
    // both leaves grouped under one membership
    const m = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId: room.id, joinNullifier: n } },
      include: { leaves: true },
    });
    expect(m?.leaves).toHaveLength(2);
  });

  it('rotates a device leaf to a new identity commitment', async () => {
    const n = 'jn-2';
    await joinRoom({ room, joinNullifier: n, identityCommitment: '444' });
    const r = await rotateDevice({
      room,
      joinNullifier: n,
      oldIdentityCommitment: '444',
      newIdentityCommitment: '555',
    });
    expect(r.ok).toBe(true);
    const leaf = await prisma.membershipLeaf.findFirst({
      where: { roomId: room.id, identityCommitment: '555' },
    });
    expect(leaf).toBeTruthy();
  });

  it('refuses to join when the membership is banned', async () => {
    const n = 'jn-3';
    await joinRoom({ room, joinNullifier: n, identityCommitment: '666' });
    await prisma.membership.update({
      where: { roomId_joinNullifier: { roomId: room.id, joinNullifier: n } },
      data: { status: MembershipStatus.BANNED },
    });
    const again = await joinRoom({ room, joinNullifier: n, identityCommitment: '777' });
    expect(again).toMatchObject({ ok: false, reason: 'banned' });
  });
});
```

- [ ] **Step 3: Run → PASS** (Postgres up). Commit:

```bash
git add services/api/src/membership
git commit -m "Add membership join/rotate with multi-device + ban guards"
```

---

## Task 8: tRPC router + standalone server

**Files:** `services/api/src/trpc/trpc.ts`, `room.router.ts`, `membership.router.ts`, `app.router.ts`, `services/api/src/server.ts`, `services/api/src/trpc/app.router.test.ts`.

- [ ] **Step 1: `trpc/trpc.ts`** (context carries the DB + the production verifier):

```ts
import { initTRPC } from '@trpc/server';

export interface Context {
  // populated per-request in server.ts / tests
}

const t = initTRPC.context<Context>().create();
export const router = t.router;
export const publicProcedure = t.procedure;
```

- [ ] **Step 2: `trpc/room.router.ts`** (read access):

```ts
import { z } from 'zod';
import { prisma } from '@discreetly/db';
import { router, publicProcedure } from './trpc.js';

export const roomRouter = router({
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    return prisma.room.findUnique({ where: { id: input.id } });
  }),
  listPublic: publicProcedure.query(async () => {
    return prisma.room.findMany({
      where: { visibility: 'PUBLIC' },
      orderBy: { createdAt: 'desc' },
    });
  }),
  // The current Merkle leaves a client needs to build an RLN proof.
  leaves: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const leaves = await prisma.membershipLeaf.findMany({
      where: { roomId: input.id, revokedAt: null },
      select: { rateCommitment: true },
    });
    return leaves.map((l) => l.rateCommitment);
  }),
});
```

- [ ] **Step 3: `trpc/membership.router.ts`** (join/rotate; ties gate → membership):

```ts
import { z } from 'zod';
import { prisma } from '@discreetly/db';
import type { PolicyNode } from '@discreetly/policy';
import { router, publicProcedure } from './trpc.js';
import { evaluateGate } from '../gate/gate.js';
import { verifyMinisterIdToken } from '../minister/verify.js';
import { joinRoom, rotateDevice } from '../membership/membership.js';

export const membershipRouter = router({
  join: publicProcedure
    .input(
      z.object({
        roomId: z.string(),
        idToken: z.string(),
        identityCommitment: z.string(),
        deviceLabel: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const room = await prisma.room.findUnique({ where: { id: input.roomId } });
      if (!room) return { ok: false as const, reason: 'no-room' as const };
      const gate = await evaluateGate({
        idToken: input.idToken,
        rlnIdentifier: BigInt(room.rlnIdentifier),
        policy: room.accessPolicy as PolicyNode,
        verify: verifyMinisterIdToken,
      });
      if (!gate.allowed) return { ok: false as const, reason: 'policy-denied' as const };
      return joinRoom({
        room,
        joinNullifier: gate.joinNullifier.toString(),
        identityCommitment: input.identityCommitment,
        deviceLabel: input.deviceLabel,
      });
    }),
  rotate: publicProcedure
    .input(
      z.object({
        roomId: z.string(),
        idToken: z.string(),
        oldIdentityCommitment: z.string(),
        newIdentityCommitment: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const room = await prisma.room.findUnique({ where: { id: input.roomId } });
      if (!room) return { ok: false as const, reason: 'no-room' as const };
      const gate = await evaluateGate({
        idToken: input.idToken,
        rlnIdentifier: BigInt(room.rlnIdentifier),
        policy: room.accessPolicy as PolicyNode,
        verify: verifyMinisterIdToken,
      });
      if (!gate.allowed) return { ok: false as const, reason: 'policy-denied' as const };
      return rotateDevice({
        room,
        joinNullifier: gate.joinNullifier.toString(),
        oldIdentityCommitment: input.oldIdentityCommitment,
        newIdentityCommitment: input.newIdentityCommitment,
      });
    }),
});
```

- [ ] **Step 4: `trpc/app.router.ts`:**

```ts
import { router } from './trpc.js';
import { roomRouter } from './room.router.js';
import { membershipRouter } from './membership.router.js';

export const appRouter = router({
  room: roomRouter,
  membership: membershipRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 5: `server.ts`** (standalone HTTP; WS added in 3b):

```ts
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { appRouter } from './trpc/app.router.js';
import { config } from './config.js';

const server = createHTTPServer({
  router: appRouter,
  middleware: (req, res, next) => {
    // permissive CORS for the Next frontend (tighten origin in prod)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    next();
  },
  createContext: () => ({}),
});

server.listen(config.API_PORT);
console.log(`[discreetly:api] tRPC on http://localhost:${config.API_PORT}`);
```

- [ ] **Step 6: Router integration test** `trpc/app.router.test.ts` — call `join` through a tRPC caller against the real DB, using a mock-issuer id_token and a room whose policy the badges satisfy:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@discreetly/db';
import { createLocalJWKSet } from 'jose';
import { appRouter } from './app.router.js';
import { makeVerifier } from '../minister/verify.js';
import * as verifyModule from '../minister/verify.js';
import {
  jwks,
  signIdToken,
  MOCK_ISSUER,
  MOCK_VC_ISSUER,
  MOCK_CLIENT_ID,
} from '../test/mock-issuer.js';

let roomId: string;

beforeAll(async () => {
  // Point the production verifier used by the router at the mock JWKS.
  const mock = makeVerifier({
    issuer: MOCK_ISSUER,
    audience: MOCK_CLIENT_ID,
    vcIssuer: MOCK_VC_ISSUER,
    jwks: createLocalJWKSet(await jwks()),
  });
  vi.spyOn(verifyModule, 'verifyMinisterIdToken').mockImplementation(mock);
  const r = await prisma.room.create({
    data: {
      name: 'Router Test',
      slug: `rt-${Date.now()}`,
      rlnIdentifier: `rln-rt-${Date.now()}`,
      rateLimit: 10_000,
      userMessageLimit: 5,
      accessPolicy: { badge: { type: 'email-domain', where: { domain: 'acme.com' } } },
    },
  });
  roomId = r.id;
});
afterAll(async () => {
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.$disconnect();
  vi.restoreAllMocks();
});

describe('membership.join via tRPC', () => {
  it('admits a user whose badge satisfies the room policy', async () => {
    const caller = appRouter.createCaller({});
    const idToken = await signIdToken({
      sub: 'router-sub',
      badges: [{ type: 'email-domain', attributes: { domain: 'acme.com' } }],
    });
    const res = await caller.membership.join({
      roomId,
      idToken,
      identityCommitment: '12345',
      deviceLabel: 'phone',
    });
    expect(res.ok).toBe(true);
    const leaves = await caller.room.leaves({ id: roomId });
    expect(leaves.length).toBe(1);
  });

  it('rejects a user missing the required badge', async () => {
    const caller = appRouter.createCaller({});
    const idToken = await signIdToken({
      sub: 'router-sub-2',
      badges: [{ type: 'invite-code', attributes: { label: 'x' } }],
    });
    const res = await caller.membership.join({ roomId, idToken, identityCommitment: '999' });
    expect(res).toMatchObject({ ok: false, reason: 'policy-denied' });
  });
});
```

Note: the router imports `verifyMinisterIdToken` directly; for the spy to take effect, import it as `import * as verify from '../minister/verify.js'` in `membership.router.ts` and call `verify.verifyMinisterIdToken`, OR inject the verifier via context. **Use context injection** (cleaner): add `verify` to `Context`, set it in `server.ts` to the production verifier and in tests to the mock. Adjust `membership.router.ts` to read `ctx.verify`. (Implementer: pick context injection; update the router + context + this test accordingly.)

- [ ] **Step 7:** `pnpm --filter @discreetly/api typecheck` + `test` green. Boot smoke: `API_PORT=3009 pnpm --filter @discreetly/api exec tsx src/server.ts &` then `curl -s localhost:3009/room.listPublic` returns a tRPC JSON envelope; kill it. Commit:

```bash
git add services/api/src/trpc services/api/src/server.ts
git commit -m "Add tRPC room + membership routers and standalone server"
```

---

## Task 9: Workspace verification

- [ ] **Step 1:** `pnpm install` → `pnpm typecheck` (all packages incl. @discreetly/api) clean.
- [ ] **Step 2:** `pnpm test` → policy, db, circuits, crypto, api all pass (api's live-interop test runs if Minister is up, else skips).
- [ ] **Step 3:** `pnpm format` (idempotent; `.prettierignore` already excludes artifacts/lockfile). Commit any formatting.

---

## Self-Review Notes (spec coverage)

- §6 auth/gate (verify id_token + VCs, configurable issuer) → Tasks 4-6.
- §7 policy evaluation at the gate → Task 6.
- §9 join / rotate / multi-device → Task 7; the join-nullifier (§4) → Task 6.
- §8 data model (Ban indexes) → Task 2.
- Crypto-consumer resolution + `computeRoot` (crypto-integration note) → Task 1.
- **Deferred to 3b:** message pipeline (RLN verify → collision → ban), Redis pub/sub, WebSocket subscriptions, the epoch-binding hardening, IDC (only if needed). `verifyRLNProof` callers must `try/catch` (it can throw) — apply in 3b's message handler.
- **Deferred to 3c:** admin tRPC (room CRUD, policy authoring, ban-by-IC/nullifier, audit).
- **Deferred to Plan 4:** Auth.js OIDC client (the browser dance), frontend, admin UI, full Playwright e2e against live Minister.

```

```
