# Discreetly v2

Anonymous, federated, zero-knowledge group chat. Membership is a Semaphore
identity commitment in a room's Merkle tree. Messages are authenticated by an
RLN (Rate-Limiting Nullifier) proof of membership that does not reveal the
sender. Exceeding the per-epoch rate limit causes a nullifier collision; Shamir
recovery then exposes the sender's secret and triggers a ban.

v2 replaces the old multi-gateway access model with **Minister** OIDC
badge-gating: per-room boolean badge policies control who can join.

For a deeper architecture walkthrough, see
[`docs/superpowers/specs/2026-06-12-discreetly-minister-gating-design.md`](docs/superpowers/specs/2026-06-12-discreetly-minister-gating-design.md).

For working-in-repo guidance (internal-package pattern, env contracts, testing),
see [`CLAUDE.md`](CLAUDE.md).

---

## Monorepo layout

pnpm workspaces + Turborepo. Workspaces are `apps/*`, `services/*`, and
`packages/*`.

```
apps/
  web/              Next 15 / React 19 frontend + admin dashboard
                    Auth.js v5 Minister OIDC client
                    tRPC client (http + ws), port 3001

services/
  api/              Long-lived Node tRPC backend (HTTP + WebSocket, port 3002)
                    Gate, membership, message pipeline, ban logic, admin control plane

packages/
  crypto/           RLN prove/verify, Shamir, field utils, signal hash,
                    rate commitment (exports "." and "./rln")
  circuits/         Vendored RLN wasm / zkey / verification-key artifacts
  policy/           Boolean access-policy types, requiredScopes(), evaluate(),
                    policyNodeSchema / parsePolicy / OPEN_POLICY
  db/               Prisma schema + client + migrations (PostgreSQL)
  shared/           Shared TS types and enums

RLN2DHCircuit/      Future feature; intentionally outside the build
docs/superpowers/   Design spec, implementation plans, notes
_legacy/            Pre-monorepo archive; gitignored; safe to delete
```

---

## Prerequisites

- **Node 20+** (`engines` enforced by pnpm)
- **pnpm 9** (`corepack enable` or install directly)
- **Docker** (Postgres 16 + Redis 7 via `docker-compose.yml`)
- **Minister** running on port 3000 for live auth
  (repo: `~/Nextcloud/workspace/MinistryOfMany/Minister`)

---

## Quickstart

```sh
# 1. Start backing services
docker compose up -d

# 2. Install dependencies (also runs prisma generate via postinstall)
pnpm install

# 3. Copy env and fill in secrets
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
# Set AUTH_SECRET (openssl rand -base64 32) and MINISTER_CLIENT_SECRET

# 4. Migrate the database
pnpm db:migrate

# 5. Start all services in watch mode
pnpm dev
```

The web app starts on `http://localhost:3001`, the API on `http://localhost:3002`.

To start only one app:

```sh
pnpm --filter @discreetly/web dev
pnpm --filter @discreetly/api dev
```

---

## Service ports

| Service   | Port |
|-----------|------|
| Minister  | 3000 |
| Web       | 3001 |
| API       | 3002 |
| Postgres  | 5432 |
| Redis     | 6379 |

---

## Environment variables

**API** (`services/api/.env.example` - copy to root `.env`):

| Variable              | Description                                      |
|-----------------------|--------------------------------------------------|
| `DATABASE_URL`        | PostgreSQL connection string                     |
| `REDIS_URL`           | Redis connection string (default: localhost:6379)|
| `MINISTER_ISSUER`     | OIDC issuer URL (http://localhost:3000)          |
| `MINISTER_JWKS_URL`   | JWKS endpoint                                    |
| `MINISTER_VC_ISSUER`  | VC issuer DID (did:web:minister.local)           |
| `MINISTER_CLIENT_ID`  | OAuth client ID (discreetly_dev)                 |
| `API_PORT`            | API listen port (default: 3002)                  |
| `ALLOWED_WS_ORIGINS`  | Comma-separated WebSocket origins allowlist      |

**Web** (`apps/web/.env.example` - copy to `apps/web/.env.local`):

| Variable                  | Description                        |
|---------------------------|------------------------------------|
| `AUTH_SECRET`             | Auth.js secret (openssl rand -base64 32) |
| `AUTH_URL`                | Auth.js base URL (http://localhost:3001) |
| `AUTH_TRUST_HOST`         | Set true in dev/behind proxy       |
| `MINISTER_ISSUER`         | OIDC issuer URL                    |
| `MINISTER_CLIENT_ID`      | OAuth client ID                    |
| `MINISTER_CLIENT_SECRET`  | OAuth client secret (gitignored)   |
| `NEXT_PUBLIC_API_URL`     | API base URL seen by the browser   |
| `NEXT_PUBLIC_API_WS_URL`  | API WebSocket URL seen by the browser |

Secrets never go in committed files - only `.env` / `apps/web/.env.local`
(both gitignored).

---

## Root scripts

All scripts run through Turborepo and execute across every workspace that
declares the matching script.

| Command           | What it does                                          |
|-------------------|-------------------------------------------------------|
| `pnpm dev`        | Start all services in watch mode (persistent)         |
| `pnpm build`      | Build all packages and apps                           |
| `pnpm typecheck`  | `tsc --noEmit` across all packages                    |
| `pnpm test`       | Run vitest across all packages                        |
| `pnpm lint`       | ESLint across all packages                            |
| `pnpm format`     | Prettier write (see `.prettierignore` for exclusions) |
| `pnpm db:generate`| Regenerate Prisma client (`@discreetly/db generate`)  |
| `pnpm db:migrate` | Apply Prisma migrations (`prisma migrate dev`)        |

---

## Testing

### Unit tests

```sh
pnpm test                        # all packages
pnpm --filter @discreetly/api test   # API only
pnpm --filter @discreetly/crypto test
```

The API test suite loads `../../.env` via `dotenv-cli`. The database and Redis
must be running. A mock Minister issuer (`services/api/src/test/mock-issuer.ts`)
serves as the OIDC provider for unit tests so the real Minister is not required.

Live Minister interop tests live in `services/api/src/test/minister-live.ts`;
they skip automatically when `MINISTER_DEV_DATABASE_URL` is unset.

### E2E (Playwright)

```sh
pnpm --filter @discreetly/web exec playwright test
```

The harness (`apps/web/e2e/harness/`) spins up:
- A mock OIDC issuer on port 3399 (deterministic, no real Minister needed)
- The API on port 3398
- The web app on port 3397

All state goes to an isolated `discreetly_e2e` Postgres database. These ports
are intentionally separate from dev ports so e2e never clashes with a running
dev stack.

---

## Architecture notes

**Trust model:** Semi-trusted / ZK-ready. The server re-verifies every RLN
proof server-side. A clean seam is preserved for a future unlinkable ZK gate
(see the Minister gating design spec).

**Ephemeral rooms:** `RoomPersistence.EPHEMERAL` rooms are a pure transport
relay. The send pipeline (`services/api/src/messaging/pipeline.ts`) verifies the
RLN proof, fans the message out over Redis pub/sub to whoever is subscribed at
that moment, and forgets it - no `Message` row is ever written, and `message.list`
returns `[]` so there is no history backfill. RLN rate-limiting/bans still work
via a transient, auto-expiring Redis record holding only the per-epoch nullifier
share point (`x:y`, never content); see
`services/api/src/messaging/ephemeral-collision.ts`. Bans (membership state)
still persist. PERSISTENT rooms are unchanged.

**IDC nullifier:** Not used in v2. The gateway/set-password flows it served
were dropped; the legacy code is archived.

---

## Scaling and no-lock-in

The API is stateless: all mutable state lives in Postgres and Redis. This means
horizontal scaling is straightforward:

- **Multiple API instances** behind a load balancer work without sticky sessions.
  Redis pub/sub fans out room broadcasts across every instance, so a message
  published by one API node reaches subscribers on all others.
- **Postgres connection pooling** - run PgBouncer or Supabase's Supavisor in
  transaction mode in front of Postgres when connection count becomes a
  bottleneck. No Prisma Accelerate or proprietary pooling layer is needed.
- **Message table growth** - partition the `Message` table by `roomId` (or by
  `createdAt` buckets) using standard Postgres declarative partitioning. The
  Prisma schema requires no changes; migrations handle the DDL.
- **No proprietary lock-in** - the stack is standard Postgres (wire protocol),
  Redis (RESP), and Node. Swap the managed provider (Neon, Railway, Fly, bare
  metal) without changing application code. All dependencies are OSS.

---

## Roadmap

The implementation plans are in `docs/superpowers/plans/`. Plans 1-4 cover
foundation, crypto port, backend (gate + messaging + admin), and frontend/e2e.
CI/deploy (Plan 5) and hardening (Plan 6) are upcoming.
