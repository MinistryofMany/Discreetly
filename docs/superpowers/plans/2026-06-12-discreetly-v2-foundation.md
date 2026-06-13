# Discreetly v2 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Discreetly v2 monorepo skeleton with a working dev environment, shared types, the Prisma/Postgres data model, and a fully-tested boolean access-policy engine.

**Architecture:** pnpm + Turborepo monorepo matching Tessera's stack. This plan delivers four internal packages — `@discreetly/shared` (types/enums), `@discreetly/db` (Prisma schema + client), `@discreetly/policy` (pure policy logic) — plus the root tooling and a `docker-compose` dev stack (Postgres + Redis). No crypto, no network services yet (those are Plans 2-4). Everything here is unit-testable in isolation.

**Tech Stack:** TypeScript 5.6 (strict, `noUncheckedIndexedAccess`), pnpm 9, Turborepo 2, Prisma 6 + PostgreSQL 16, Redis 7, Vitest 2, Node 20.

**Reference spec:** `docs/superpowers/specs/2026-06-12-discreetly-tessera-gating-design.md` (§5 architecture, §7 policy model, §8 data model).

---

## File Structure (created by this plan)

```
discreetly/
├── package.json                      # root workspace + turbo scripts
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json                # shared strict TS config
├── .nvmrc                            # 20
├── .npmrc
├── .prettierrc.json
├── docker-compose.yml                # postgres + redis (dev)
├── .env.example
├── packages/
│   ├── shared/
│   │   ├── package.json              # @discreetly/shared
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts              # re-exports
│   │       └── enums.ts              # RoomVisibility, MembershipStatus, ...
│   ├── policy/
│   │   ├── package.json              # @discreetly/policy
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types.ts              # PolicyNode, VerifiedBadge, type guards
│   │       ├── required-scopes.ts
│   │       ├── required-scopes.test.ts
│   │       ├── evaluate.ts
│   │       └── evaluate.test.ts
│   └── db/
│       ├── package.json              # @discreetly/db
│       ├── tsconfig.json
│       ├── prisma/schema.prisma
│       └── src/index.ts              # exports PrismaClient instance + types
```

---

## Task 1: Root workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.nvmrc`, `.npmrc`, `.prettierrc.json`

- [ ] **Step 1: Create the workspace manifest**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "services/*"
  - "packages/*"
```

- [ ] **Step 2: Create the root `package.json`**

Create `package.json`:

```json
{
  "name": "discreetly",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20.0.0", "pnpm": ">=9.0.0" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "format": "prettier --write \"**/*.{ts,tsx,js,jsx,json,md,prisma,yml,yaml}\"",
    "db:generate": "pnpm --filter @discreetly/db generate",
    "db:migrate": "pnpm --filter @discreetly/db migrate"
  },
  "devDependencies": {
    "prettier": "^3.3.3",
    "prettier-plugin-prisma": "^5.0.0",
    "turbo": "^2.3.3",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 3: Create `turbo.json`**

Create `turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "dev": { "cache": false, "persistent": true },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

- [ ] **Step 4: Create the shared TS config**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 5: Create dev-tool dotfiles**

Create `.nvmrc`:

```
20
```

Create `.npmrc`:

```
auto-install-peers=true
strict-peer-dependencies=false
```

Create `.prettierrc.json`:

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "plugins": ["prettier-plugin-prisma"]
}
```

- [ ] **Step 6: Install and verify the workspace resolves**

Run: `pnpm install`
Expected: completes without error; creates `pnpm-lock.yaml` and root `node_modules`.

Run: `pnpm exec turbo run typecheck`
Expected: "No tasks were executed" or a clean run (no packages defined yet, so zero tasks — exit code 0).

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .nvmrc .npmrc .prettierrc.json pnpm-lock.yaml
git commit -m "Scaffold pnpm + turborepo workspace"
```

---

## Task 2: Dev infrastructure (Postgres + Redis)

**Files:**
- Create: `docker-compose.yml`, `.env.example`

- [ ] **Step 1: Create the compose file**

Create `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: discreetly
      POSTGRES_PASSWORD: discreetly
      POSTGRES_DB: discreetly
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U discreetly"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  pgdata:
```

- [ ] **Step 2: Create `.env.example`**

Create `.env.example`:

```
DATABASE_URL="postgresql://discreetly:discreetly@localhost:5432/discreetly?schema=public"
REDIS_URL="redis://localhost:6379"
```

- [ ] **Step 3: Boot the stack and verify health**

Run: `docker compose up -d`
Expected: `postgres` and `redis` start.

Run: `docker compose ps`
Expected: both services show `running` and `healthy`.

- [ ] **Step 4: Create your local `.env`**

Run: `cp .env.example .env`
Expected: `.env` exists (gitignored — confirm `git status` does NOT list `.env`).

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "Add Postgres + Redis dev compose stack"
```

---

## Task 3: `@discreetly/shared` — types and enums

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/enums.ts`, `packages/shared/src/index.ts`

- [ ] **Step 1: Create the package manifest**

Create `packages/shared/package.json`:

```json
{
  "name": "@discreetly/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "echo \"(no lint configured)\"",
    "test": "echo \"(no tests)\""
  },
  "devDependencies": {
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 2: Create the package tsconfig**

Create `packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"]
}
```

- [ ] **Step 3: Create the enums**

Create `packages/shared/src/enums.ts`. These string-enum values MUST match the Prisma enums in Task 6 exactly.

```ts
export enum RoomVisibility {
  PUBLIC = 'PUBLIC',
  PRIVATE = 'PRIVATE',
}

export enum RoomPersistence {
  PERSISTENT = 'PERSISTENT',
  EPHEMERAL = 'EPHEMERAL',
}

export enum RoomEncryption {
  PLAINTEXT = 'PLAINTEXT',
  AES = 'AES',
}

export enum MembershipStatus {
  ACTIVE = 'ACTIVE',
  BANNED = 'BANNED',
}

export enum BanReason {
  RATE_LIMIT_COLLISION = 'RATE_LIMIT_COLLISION',
  ADMIN = 'ADMIN',
}

export enum MessageType {
  TEXT = 'TEXT',
  PIXEL = 'PIXEL',
  POLL = 'POLL',
  SYSTEM = 'SYSTEM',
}
```

- [ ] **Step 4: Create the barrel export**

Create `packages/shared/src/index.ts`:

```ts
export * from './enums.js';
```

- [ ] **Step 5: Typecheck the package**

Run: `pnpm --filter @discreetly/shared typecheck`
Expected: PASS (no type errors).

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "Add @discreetly/shared types and enums"
```

---

## Task 4: `@discreetly/policy` — types and guards

**Files:**
- Create: `packages/policy/package.json`, `packages/policy/tsconfig.json`, `packages/policy/vitest.config.ts`, `packages/policy/src/types.ts`, `packages/policy/src/index.ts`

- [ ] **Step 1: Create the package manifest**

Create `packages/policy/package.json`:

```json
{
  "name": "@discreetly/policy",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "echo \"(no lint configured)\"",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create the package tsconfig**

Create `packages/policy/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"]
}
```

- [ ] **Step 3: Create the vitest config**

Create `packages/policy/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create the policy types and type guards**

Create `packages/policy/src/types.ts`:

```ts
export type PolicyAttrValue = string | number | boolean;

export interface BadgeLeaf {
  badge: {
    type: string;
    where?: Record<string, PolicyAttrValue>;
    /** Badge must have been issued within this many days of `now`. */
    maxAgeDays?: number;
  };
}

export interface AllOfNode {
  allOf: PolicyNode[];
}

export interface AnyOfNode {
  anyOf: PolicyNode[];
}

export interface AtLeastNode {
  atLeast: { n: number; of: PolicyNode[] };
}

export type PolicyNode = BadgeLeaf | AllOfNode | AnyOfNode | AtLeastNode;

/** A badge the user disclosed, after its VC signature was verified. */
export interface VerifiedBadge {
  type: string;
  attributes: Record<string, PolicyAttrValue>;
  /** VC `iat`, unix seconds. */
  issuedAt: number;
}

export function isBadgeLeaf(node: PolicyNode): node is BadgeLeaf {
  return 'badge' in node;
}

export function isAllOf(node: PolicyNode): node is AllOfNode {
  return 'allOf' in node;
}

export function isAnyOf(node: PolicyNode): node is AnyOfNode {
  return 'anyOf' in node;
}

export function isAtLeast(node: PolicyNode): node is AtLeastNode {
  return 'atLeast' in node;
}
```

- [ ] **Step 5: Create the barrel export**

Create `packages/policy/src/index.ts`:

```ts
export * from './types.js';
export * from './required-scopes.js';
export * from './evaluate.js';
```

(`required-scopes.js` and `evaluate.js` are created in Tasks 5 and 6. The barrel will not typecheck until then — that is expected; the next typecheck step is in Task 6.)

- [ ] **Step 6: Commit**

```bash
git add packages/policy/package.json packages/policy/tsconfig.json packages/policy/vitest.config.ts packages/policy/src/types.ts packages/policy/src/index.ts
git commit -m "Add @discreetly/policy types and guards"
```

---

## Task 5: `requiredScopes()` (TDD)

**Files:**
- Create: `packages/policy/src/required-scopes.test.ts`
- Create: `packages/policy/src/required-scopes.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/policy/src/required-scopes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { requiredScopes } from './required-scopes.js';
import type { PolicyNode } from './types.js';

describe('requiredScopes', () => {
  it('returns a single scope for a single badge leaf', () => {
    const policy: PolicyNode = { badge: { type: 'email-domain', where: { domain: 'acme.com' } } };
    expect(requiredScopes(policy)).toEqual(['badge:email-domain']);
  });

  it('collects and dedupes badge types across a nested tree, sorted', () => {
    const policy: PolicyNode = {
      allOf: [
        {
          atLeast: {
            n: 2,
            of: [
              { badge: { type: 'oauth-account', where: { provider: 'github' } } },
              { badge: { type: 'oauth-account', where: { provider: 'google' } } },
              { badge: { type: 'oauth-account', where: { provider: 'steam' } } },
            ],
          },
        },
        { badge: { type: 'steam-game', where: { gameId: 'GAME_X' } } },
      ],
    };
    expect(requiredScopes(policy)).toEqual(['badge:oauth-account', 'badge:steam-game']);
  });

  it('handles anyOf', () => {
    const policy: PolicyNode = {
      anyOf: [{ badge: { type: 'residency-country' } }, { badge: { type: 'email-domain' } }],
    };
    expect(requiredScopes(policy)).toEqual(['badge:email-domain', 'badge:residency-country']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @discreetly/policy test`
Expected: FAIL — cannot resolve `./required-scopes.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/policy/src/required-scopes.ts`:

```ts
import { type PolicyNode, isBadgeLeaf, isAllOf, isAnyOf, isAtLeast } from './types.js';

/** Distinct `badge:<type>` OIDC scopes a room policy requires, sorted. */
export function requiredScopes(policy: PolicyNode): string[] {
  const types = new Set<string>();

  const walk = (node: PolicyNode): void => {
    if (isBadgeLeaf(node)) {
      types.add(node.badge.type);
      return;
    }
    if (isAllOf(node)) {
      node.allOf.forEach(walk);
      return;
    }
    if (isAnyOf(node)) {
      node.anyOf.forEach(walk);
      return;
    }
    if (isAtLeast(node)) {
      node.atLeast.of.forEach(walk);
      return;
    }
  };

  walk(policy);
  return [...types].sort().map((type) => `badge:${type}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @discreetly/policy test`
Expected: PASS (3 tests in `required-scopes.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add packages/policy/src/required-scopes.ts packages/policy/src/required-scopes.test.ts
git commit -m "Add requiredScopes policy walker"
```

---

## Task 6: `evaluate()` (TDD)

**Files:**
- Create: `packages/policy/src/evaluate.test.ts`
- Create: `packages/policy/src/evaluate.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/policy/src/evaluate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluate } from './evaluate.js';
import type { PolicyNode, VerifiedBadge } from './types.js';

const NOW = 1_750_000_000; // fixed unix seconds for deterministic expiry tests
const DAY = 86_400;

function badge(type: string, attributes: VerifiedBadge['attributes'] = {}, ageDays = 0): VerifiedBadge {
  return { type, attributes, issuedAt: NOW - ageDays * DAY };
}

describe('evaluate', () => {
  it('matches a single badge leaf by type', () => {
    const policy: PolicyNode = { badge: { type: 'email-domain' } };
    expect(evaluate(policy, [badge('email-domain')], NOW)).toBe(true);
    expect(evaluate(policy, [badge('oauth-account')], NOW)).toBe(false);
  });

  it('enforces attribute constraints', () => {
    const policy: PolicyNode = { badge: { type: 'email-domain', where: { domain: 'acme.com' } } };
    expect(evaluate(policy, [badge('email-domain', { domain: 'acme.com' })], NOW)).toBe(true);
    expect(evaluate(policy, [badge('email-domain', { domain: 'evil.com' })], NOW)).toBe(false);
  });

  it('enforces maxAgeDays expiry', () => {
    const policy: PolicyNode = { badge: { type: 'age-check', maxAgeDays: 30 } };
    expect(evaluate(policy, [badge('age-check', {}, 10)], NOW)).toBe(true);
    expect(evaluate(policy, [badge('age-check', {}, 31)], NOW)).toBe(false);
  });

  it('allOf requires every child', () => {
    const policy: PolicyNode = {
      allOf: [{ badge: { type: 'residency-country', where: { country: 'PT' } } }, { badge: { type: 'email-domain', where: { domain: 'acme.com' } } }],
    };
    expect(evaluate(policy, [badge('residency-country', { country: 'PT' }), badge('email-domain', { domain: 'acme.com' })], NOW)).toBe(true);
    expect(evaluate(policy, [badge('residency-country', { country: 'PT' })], NOW)).toBe(false);
  });

  it('anyOf requires at least one child', () => {
    const policy: PolicyNode = { anyOf: [{ badge: { type: 'a' } }, { badge: { type: 'b' } }] };
    expect(evaluate(policy, [badge('b')], NOW)).toBe(true);
    expect(evaluate(policy, [badge('c')], NOW)).toBe(false);
  });

  it('atLeast requires n satisfied children', () => {
    const policy: PolicyNode = {
      atLeast: { n: 2, of: [{ badge: { type: 'a' } }, { badge: { type: 'b' } }, { badge: { type: 'c' } }] },
    };
    expect(evaluate(policy, [badge('a'), badge('b')], NOW)).toBe(true);
    expect(evaluate(policy, [badge('a')], NOW)).toBe(false);
  });

  it('evaluates the personhood + topic example', () => {
    const policy: PolicyNode = {
      allOf: [
        {
          atLeast: {
            n: 2,
            of: [
              { badge: { type: 'oauth-account', where: { provider: 'github' } } },
              { badge: { type: 'oauth-account', where: { provider: 'google' } } },
              { badge: { type: 'oauth-account', where: { provider: 'steam' } } },
            ],
          },
        },
        { badge: { type: 'steam-game', where: { gameId: 'GAME_X', completed: true } } },
      ],
    };
    const ok = [
      badge('oauth-account', { provider: 'github' }),
      badge('oauth-account', { provider: 'steam' }),
      badge('steam-game', { gameId: 'GAME_X', completed: true }),
    ];
    expect(evaluate(policy, ok, NOW)).toBe(true);

    const missingTopic = [badge('oauth-account', { provider: 'github' }), badge('oauth-account', { provider: 'steam' })];
    expect(evaluate(policy, missingTopic, NOW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @discreetly/policy test`
Expected: FAIL — cannot resolve `./evaluate.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/policy/src/evaluate.ts`:

```ts
import {
  type PolicyNode,
  type VerifiedBadge,
  type BadgeLeaf,
  isBadgeLeaf,
  isAllOf,
  isAnyOf,
  isAtLeast,
} from './types.js';

const SECONDS_PER_DAY = 86_400;

function leafSatisfied(leaf: BadgeLeaf, badges: VerifiedBadge[], now: number): boolean {
  const { type, where, maxAgeDays } = leaf.badge;
  return badges.some((candidate) => {
    if (candidate.type !== type) return false;
    if (maxAgeDays !== undefined && now - candidate.issuedAt > maxAgeDays * SECONDS_PER_DAY) {
      return false;
    }
    if (where) {
      for (const [key, value] of Object.entries(where)) {
        if (candidate.attributes[key] !== value) return false;
      }
    }
    return true;
  });
}

/**
 * Evaluate a room access policy against the set of verified, disclosed badges.
 * `now` is unix seconds, passed in for deterministic testing.
 */
export function evaluate(policy: PolicyNode, badges: VerifiedBadge[], now: number): boolean {
  if (isBadgeLeaf(policy)) return leafSatisfied(policy, badges, now);
  if (isAllOf(policy)) return policy.allOf.every((node) => evaluate(node, badges, now));
  if (isAnyOf(policy)) return policy.anyOf.some((node) => evaluate(node, badges, now));
  if (isAtLeast(policy)) {
    const satisfied = policy.atLeast.of.filter((node) => evaluate(node, badges, now)).length;
    return satisfied >= policy.atLeast.n;
  }
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @discreetly/policy test`
Expected: PASS (all tests in `required-scopes.test.ts` and `evaluate.test.ts`).

- [ ] **Step 5: Typecheck the whole package (barrel now resolves)**

Run: `pnpm --filter @discreetly/policy typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/policy/src/evaluate.ts packages/policy/src/evaluate.test.ts
git commit -m "Add policy evaluate engine with full boolean + expiry support"
```

---

## Task 7: `@discreetly/db` — Prisma schema and client

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/prisma/schema.prisma`, `packages/db/src/index.ts`, `packages/db/src/smoke.test.ts`

- [ ] **Step 1: Create the package manifest**

Create `packages/db/package.json`:

```json
{
  "name": "@discreetly/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "generate": "prisma generate",
    "migrate": "prisma migrate dev",
    "validate": "prisma validate",
    "studio": "prisma studio",
    "typecheck": "tsc --noEmit",
    "lint": "echo \"(no lint configured)\"",
    "test": "vitest run"
  },
  "dependencies": {
    "@prisma/client": "^6.1.0"
  },
  "devDependencies": {
    "prisma": "^6.1.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create the package tsconfig**

Create `packages/db/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "prisma"]
}
```

- [ ] **Step 3: Create the Prisma schema**

Create `packages/db/prisma/schema.prisma`. Enum values MUST match `packages/shared/src/enums.ts` from Task 3.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum RoomVisibility {
  PUBLIC
  PRIVATE
}

enum RoomPersistence {
  PERSISTENT
  EPHEMERAL
}

enum RoomEncryption {
  PLAINTEXT
  AES
}

enum MembershipStatus {
  ACTIVE
  BANNED
}

enum BanReason {
  RATE_LIMIT_COLLISION
  ADMIN
}

model Room {
  id               String           @id @default(cuid())
  name             String
  slug             String           @unique
  description      String?
  rlnIdentifier    String           @unique
  rateLimit        Int // milliseconds per epoch
  userMessageLimit Int
  maxDevices       Int              @default(5)
  visibility       RoomVisibility   @default(PUBLIC)
  persistence      RoomPersistence  @default(PERSISTENT)
  encryption       RoomEncryption   @default(PLAINTEXT)
  passwordHash     String?
  accessPolicy     Json
  createdAt        DateTime         @default(now())
  updatedAt        DateTime         @updatedAt

  memberships Membership[]
  leaves      MembershipLeaf[]
  messages    Message[]
  bans        Ban[]
}

model Membership {
  id            String           @id @default(cuid())
  roomId        String
  room          Room             @relation(fields: [roomId], references: [id], onDelete: Cascade)
  joinNullifier String
  status        MembershipStatus @default(ACTIVE)
  createdAt     DateTime         @default(now())
  updatedAt     DateTime         @updatedAt

  leaves MembershipLeaf[]

  @@unique([roomId, joinNullifier])
  @@index([roomId, status])
}

model MembershipLeaf {
  id                 String     @id @default(cuid())
  membershipId       String
  membership         Membership @relation(fields: [membershipId], references: [id], onDelete: Cascade)
  roomId             String
  room               Room       @relation(fields: [roomId], references: [id], onDelete: Cascade)
  identityCommitment String
  rateCommitment     String
  deviceLabel        String?
  createdAt          DateTime   @default(now())
  revokedAt          DateTime?

  @@unique([roomId, rateCommitment])
  @@index([membershipId])
}

model Ban {
  id             String    @id @default(cuid())
  roomId         String
  room           Room      @relation(fields: [roomId], references: [id], onDelete: Cascade)
  joinNullifier  String?
  rateCommitment String?
  reason         BanReason
  shamirSecret   String?
  createdAt      DateTime  @default(now())

  @@index([roomId, joinNullifier])
}

model Message {
  id           String   @id @default(cuid())
  roomId       String
  room         Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  epoch        BigInt
  rlnNullifier String
  content      String
  proof        Json
  sessionColor String?
  createdAt    DateTime @default(now())

  @@unique([roomId, epoch, rlnNullifier])
  @@index([roomId, epoch])
}

model AdminUser {
  id          String   @id @default(cuid())
  pairwiseSub String   @unique
  label       String?
  createdAt   DateTime @default(now())
}

model AuditLog {
  id        String   @id @default(cuid())
  actor     String
  action    String
  target    String?
  metadata  Json?
  createdAt DateTime @default(now())

  @@index([createdAt])
}
```

- [ ] **Step 4: Validate the schema**

Run: `pnpm --filter @discreetly/db validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀".

- [ ] **Step 5: Create the initial migration against the dev database**

Ensure Postgres is up (`docker compose ps` shows postgres healthy) and `.env` has `DATABASE_URL`.

Run: `pnpm --filter @discreetly/db exec prisma migrate dev --name init`
Expected: creates `packages/db/prisma/migrations/<timestamp>_init/migration.sql`, applies it, and generates the client. Output ends with "Your database is now in sync with your schema."

- [ ] **Step 6: Create the client export**

Create `packages/db/src/index.ts`:

```ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export * from '@prisma/client';
```

- [ ] **Step 7: Write a smoke test**

Create `packages/db/src/smoke.test.ts`. It exercises the membership grouping invariant: one Membership owning multiple device leaves, with the room's unique constraint on `rateCommitment`.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from './index.js';

describe('db smoke', () => {
  let roomId: string;

  beforeAll(async () => {
    const room = await prisma.room.create({
      data: {
        name: 'Smoke Room',
        slug: `smoke-${Date.now()}`,
        rlnIdentifier: `rln-${Date.now()}`,
        rateLimit: 10_000,
        userMessageLimit: 5,
        accessPolicy: { badge: { type: 'email-domain' } },
      },
    });
    roomId = room.id;
  });

  afterAll(async () => {
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.$disconnect();
  });

  it('groups multiple device leaves under one membership', async () => {
    const membership = await prisma.membership.create({
      data: {
        roomId,
        joinNullifier: 'nullifier-abc',
        leaves: {
          create: [
            { roomId, identityCommitment: 'IC1', rateCommitment: 'RC1', deviceLabel: 'Phone' },
            { roomId, identityCommitment: 'IC2', rateCommitment: 'RC2', deviceLabel: 'Laptop' },
          ],
        },
      },
      include: { leaves: true },
    });

    expect(membership.leaves).toHaveLength(2);

    const fetched = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId, joinNullifier: 'nullifier-abc' } },
      include: { leaves: true },
    });
    expect(fetched?.leaves.map((l) => l.rateCommitment).sort()).toEqual(['RC1', 'RC2']);
  });

  it('rejects a duplicate rateCommitment in the same room', async () => {
    await expect(
      prisma.membershipLeaf.create({
        data: { roomId, membershipId: (await firstMembership(roomId)).id, identityCommitment: 'IC3', rateCommitment: 'RC1' },
      }),
    ).rejects.toThrow();
  });
});

async function firstMembership(roomId: string) {
  const m = await prisma.membership.findFirst({ where: { roomId } });
  if (!m) throw new Error('expected a membership');
  return m;
}
```

- [ ] **Step 8: Run the smoke test**

Run: `pnpm --filter @discreetly/db test`
Expected: PASS (2 tests). Requires Postgres up and migrated (Step 5).

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @discreetly/db typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "Add @discreetly/db Prisma schema, client, and smoke tests"
```

---

## Task 8: Workspace-wide verification

**Files:** none (verification only)

- [ ] **Step 1: Install at root to link all workspace packages**

Run: `pnpm install`
Expected: links `@discreetly/shared`, `@discreetly/policy`, `@discreetly/db`; no errors.

- [ ] **Step 2: Run the full test suite via Turbo**

Run: `pnpm test`
Expected: Turbo runs `test` across packages; `@discreetly/policy` and `@discreetly/db` pass; others report no tests.

- [ ] **Step 3: Run the full typecheck via Turbo**

Run: `pnpm typecheck`
Expected: all packages typecheck clean.

- [ ] **Step 4: Format check**

Run: `pnpm format`
Expected: Prettier formats files; re-running shows no changes. Commit any formatting:

```bash
git add -A
git commit -m "Format foundation packages" || echo "nothing to format"
```

---

## Self-Review Notes (spec coverage)

- §5 monorepo layout → Tasks 1, 3, 4, 7 (apps/ and services/ scaffolded in Plans 3-4).
- §5 data layer (Postgres + Redis, no lock-in) → Task 2; Redis is wired by the backend in Plan 3.
- §7 policy model (`requiredScopes`, `evaluate`, attribute constraints, per-predicate expiry) → Tasks 4-6, fully tested.
- §8 data model (Room, Membership, MembershipLeaf, Ban, Message, AdminUser, AuditLog; MD-B grouping; DB-enforced collision unique constraint) → Task 7.
- §11 crypto core, §6 gate/auth, §9 message/ban flows, §12-13 frontend/admin → out of scope for this plan (Plans 2-4).

**Deferred to Plan 2:** `packages/crypto`, `packages/circuits` (RLN verify/prove, Shamir, IDC, parity tests).
**Deferred to Plan 3:** `services/api` (tRPC, Auth.js gate, join/rotate, message pipeline, ban implementation, Redis pub/sub).
**Deferred to Plan 4:** `apps/web` (chat UI, identity, onboarding, admin dashboard).
