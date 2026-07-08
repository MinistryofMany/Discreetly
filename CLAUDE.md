# Working in this repo

Discreetly v2 - anonymous ZK chat. See [`README.md`](README.md) for what it is
and how to run it. This file covers what you need to work effectively as a
developer or agent: repo layout, the internal-package pattern and its gotchas,
commands, the env/Minister contract, testing, and where specs and plans live.

---

## Repo structure

```
apps/web/           Next 15 / React 19 frontend (port 3001)
services/api/       Node tRPC backend (port 3002)
packages/
  crypto/           RLN prove/verify, Shamir, field utils ("." + "./rln" exports)
  circuits/         Vendored RLN wasm/zkey/vkey artifacts (no build step)
  policy/           Boolean badge-policy engine (types, requiredScopes, evaluate)
  db/               Prisma schema, client, migrations
  shared/           TS types and enums shared across packages
docs/superpowers/
  specs/            Architecture and design specs
  plans/            Implementation plans (Plans 1-4 complete; 5-6 upcoming)
RLN2DHCircuit/      Future feature, outside the build - do not touch
_legacy/            Pre-monorepo archive, gitignored
```

The monorepo is pnpm workspaces (`apps/*`, `services/*`, `packages/*`) +
Turborepo. The root `turbo.json` defines tasks: `build`, `dev`, `typecheck`,
`test`, `lint`, and `generate` (for Prisma client).

---

## Internal-package pattern

**This is non-obvious. Read this before importing anything.**

All workspace packages (`@discreetly/shared`, `@discreetly/crypto`,
`@discreetly/policy`, `@discreetly/db`, `@discreetly/circuits`) export their
TypeScript source directly. Their `package.json` `main` / `exports` fields point
at `./src/*.ts`. There is no build step for these packages. Consumers are
responsible for transpiling them.

- **The API** (`services/api`) uses `tsx` to run TypeScript natively, so it can
  import workspace source directly.
- **The web app** (`apps/web`) uses Next.js `transpilePackages` in
  `next.config.mjs` to transpile workspace packages during the Next build.

### TypeScript `moduleResolution: Bundler`

`tsconfig.base.json` sets `"moduleResolution": "Bundler"`. Workspace packages
write NodeNext-style `.js` import specifiers in source (e.g.
`export * from './field.js'`) but the files on disk are `.ts`. This works for
`tsx` (API). For the Next webpack build, `next.config.mjs` adds a
`resolve.extensionAlias` rule that maps `.js` requests to `['.ts', '.tsx',
'.js', '.jsx']` so webpack resolves them correctly.

### External-library type shims

Some third-party libraries (`@semaphore-protocol/group`, `ffjavascript`,
`rlnjs`, `@semaphore-protocol/identity`) ship runtime code but their
`package.json` `exports` maps omit a resolvable `"types"` condition under
`moduleResolution: Bundler`. Ambient `.d.ts` shims work around this:

- `packages/shared/src/types/external-shims.d.ts` - declares `ffjavascript`
  and `@semaphore-protocol/group`; included by `@discreetly/crypto` consumers
- `apps/web/src/types/external-shims.d.ts` - declares `@semaphore-protocol/identity`
  and `rlnjs` for the web app

If you add a new third-party dep with a missing types export condition, add an
ambient shim to the appropriate file rather than disabling type checks.

### `@discreetly/circuits` browser stub

`@discreetly/circuits` reads artifact files from disk via `node:fs` (Node-only).
The web app never calls it directly for proving - it passes `Uint8Array` artifacts.
`next.config.mjs` aliases `@discreetly/circuits` to
`apps/web/src/lib/circuits-browser-stub.ts` for client-side bundles, removing
the `node:fs` dependency from the browser bundle.

### WebAssembly + snark worker CSP

Two webpack / CSP additions are required for the RLN browser prover:

- `config.experiments.asyncWebAssembly = true` in webpack config so rlnjs can
  load the RLN circuit wasm.
- `worker-src 'self' blob: data:` in the CSP - ffjavascript (the snark prover)
  spawns its thread workers from a `data:application/javascript` URL.

If either of these is missing, proving will fail silently or with an opaque
worker/wasm error in the browser.

---

## Commands

All root scripts run through Turborepo.

```sh
pnpm dev                          # start all services (watch mode)
pnpm build                        # build all
pnpm typecheck                    # tsc --noEmit across all packages
pnpm test                         # vitest across all packages
pnpm lint                         # eslint across all packages
pnpm format                       # prettier write (see .prettierignore)
pnpm db:generate                  # regenerate Prisma client
pnpm db:migrate                   # prisma migrate dev (reads root .env)
```

Per-package:

```sh
pnpm --filter @discreetly/web dev
pnpm --filter @discreetly/api dev
pnpm --filter @discreetly/api test
pnpm --filter @discreetly/web exec playwright test   # e2e
```

The `db:generate` command runs `pnpm --filter @discreetly/db generate`, which
calls `prisma generate`. This also runs automatically as a `postinstall` hook in
`packages/db` so `pnpm install` keeps the Prisma client in sync. The Turborepo
`generate` task is a dependency of `build`, `typecheck`, and `test` to ensure
the client is generated before anything that imports it.

---

## Environment variables

Two env files are needed (both gitignored):

- **`.env`** (root) - consumed by the API and by `dotenv-cli` in `packages/db`
  scripts
- **`apps/web/.env.local`** - consumed by Next.js

Copy from the examples:

```sh
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
```

**Root `.env` (API + db):**

```
DATABASE_URL="postgresql://discreetly:discreetly@localhost:5432/discreetly?schema=public"
REDIS_URL="redis://localhost:6379"
MINISTER_ISSUER="http://localhost:3000"
MINISTER_CLIENT_ID="discreetly_dev"
MINISTER_CLIENT_SECRET="<from Minister dev config>"
API_PORT="3002"
ALLOWED_WS_ORIGINS="http://localhost:3000,http://localhost:3001,http://localhost:5173"
DISCREETLY_OPERATOR_SUBS="<your Minister pairwise sub>"
```

Note: `DATABASE_URL`, `REDIS_URL`, `MINISTER_ISSUER`, `MINISTER_CLIENT_ID`, and
`API_PORT` are validated by the zod schema in `services/api/src/config.ts`
(required at startup). The SDK derives the badge VC issuer DID
(`did:web:<host>`) from `MINISTER_ISSUER`'s host with no override, so that host
must equal Minister's `MINISTER_ISSUER_DOMAIN`; `loadConfig` re-runs the
derivation at boot and fails loud on an unusable issuer. Optionally set
`MINISTER_VC_ISSUER` to the DID Minister actually stamps and boot also asserts
the derived DID equals it (catches the host-mismatch foot-gun at startup
instead of silently rejecting every badge at runtime). `ALLOWED_WS_ORIGINS` is
read directly from `process.env` in `server.ts` with a hardcoded fallback and
is not part of the zod schema. `DISCREETLY_OPERATOR_SUBS` is the operator
(admin) allowlist: comma-separated Minister pairwise subs; every `admin.*`
procedure requires the caller's verified id_token sub to be in it, and it FAILS
CLOSED (unset/empty = no operator, every admin call FORBIDDEN). A signed-in
user finds their sub on `/identity` (or the `/admin` not-authorized panel).

**`apps/web/.env.local`:**

```
AUTH_SECRET="<openssl rand -base64 32>"
AUTH_URL="http://localhost:3001"
AUTH_TRUST_HOST=true
MINISTER_ISSUER="http://localhost:3000"
MINISTER_CLIENT_ID="discreetly_dev"
MINISTER_CLIENT_SECRET="<from Minister dev config>"
NEXT_PUBLIC_API_URL="http://localhost:3002"
NEXT_PUBLIC_API_WS_URL="ws://localhost:3002"
```

---

## Minister OIDC contract

Minister is a separate project at `~/Nextcloud/workspace/MinistryOfMany/Minister`
(not part of this repo). Do not modify it from here.

- OIDC base: `http://localhost:3000`
- Authorize: `/oidc/authorize`
- Token: `/oidc/token`
- JWKS: `/.well-known/jwks.json`
- PKCE: S256, state + nonce required
- `id_token` algorithm: EdDSA
- `sub`: pairwise (different per client)
- Badges claim: **`minister_badges`** - array of VC JWT strings
- VC type: **`Minister<Pascal>Credential`** (e.g. `MinisterEmailDomainCredential`)
- VC issuer: `did:web:minister.local` (`vc.iss`)
- Discreetly client ID: `discreetly_dev`
- Redirect URI: `http://localhost:3001/api/auth/callback/minister`

Policy evaluation (`@discreetly/policy`) takes the parsed badges and evaluates
the boolean policy tree against the badge set. `requiredScopes()` derives the
OIDC scopes to request based on the policy (e.g. `badge:email-domain`).

---

## Testing

### Unit tests

The API test suite loads `../../.env` via `dotenv-cli` (requires Postgres +
Redis running). A self-contained mock Minister issuer in
`services/api/src/test/mock-issuer.ts` signs tokens deterministically, so unit
tests do not need the real Minister.

Live Minister interop (`services/api/src/test/minister-live.ts`) is opt-in:
set `MINISTER_DEV_DATABASE_URL` to enable the DB-mediated token grant against a
live Minister instance. The test returns null and skips if the env var is unset
or the database is unreachable.

### E2E (Playwright)

```sh
pnpm --filter @discreetly/web exec playwright test
```

Config: `apps/web/playwright.config.ts`. The global setup
(`apps/web/e2e/harness/global-setup.ts`) provisions an isolated
`discreetly_e2e` Postgres database, builds the web app with e2e env, and boots:

- Mock OIDC issuer on port **3399** (deterministic, no real Minister)
- API on port **3398**
- Web app on port **3397**

These are intentionally different from dev ports (3000/3001/3002) so the suite
never clashes with a running dev stack. Global teardown stops all three servers.

---

## Known gaps and resolved decisions

**Router output types and TS2589:** `inferRouterOutputs<AppRouter>` trips
TS2589 ("type instantiation is excessively deep") when indexing into the
recursive Prisma `Json` columns (`accessPolicy`, audit `metadata`). Resolution:
`services/api/src/trpc/outputs.ts` defines explicit named types (`PublicRoom`,
`AdminRoom`, etc.) by `Omit`-ing the deep columns from the inferred type and
re-declaring them with the precise application type (`PolicyNode`) or `unknown`.
These are re-exported from `services/api/src/server.ts` as `@discreetly/api`
public surface. Web `*-types.ts` files import from `@discreetly/api` rather than
re-declaring shapes, so a resolver change breaks the type instead of drifting
silently.

`message.subscribe` yields `RoomBroadcast` (a discriminated union); tRPC's
`inferRouterOutputs` does not cover subscription yield types. `ChatBroadcast`,
`SystemBroadcast`, and `RoomBroadcast` are re-exported from `server.ts` and
imported by `apps/web/src/lib/broadcast-types.ts` - same "break not drift"
guarantee.

**Ephemeral rooms:** `RoomPersistence.EPHEMERAL` rooms are transport-only.
`sendMessage` (`services/api/src/messaging/pipeline.ts`) branches on
`room.persistence`: for EPHEMERAL it verifies the proof, runs an atomic
transient collision check (`ephemeral-collision.ts`), then `publishMessage()`s
over Redis and returns - it never calls `prisma.message.create()`. The
collision store is a per-epoch Redis key `eph:nul:<roomId>:<epoch>:<nullifier>`
= `"<x>:<y>"` set with `PX = rateLimit * 4` via a single GET-or-SET Lua script
(race-free). `message.list` returns `[]` for EPHEMERAL, so late joiners get no
backfill. Bans still persist through the shared `handleCollision` path.

**IDC nullifier:** Not used in v2. The legacy gateway/set-password flows it
served were dropped. The `idc-nullifier` package and its `idcNullifier/` and
`claimcodes/` directories are archived.

**`_legacy/` directory:** Pre-monorepo reference trees archived to a gitignored
`_legacy/` directory. Safe to delete when no longer needed for reference.

**`RLN2DHCircuit/`:** A future 2D RLN circuit feature. Intentionally outside the
build pipeline. Do not add it to `pnpm-workspace.yaml` or import from it.

---

## Specs and plans

Design: `docs/superpowers/specs/2026-06-12-discreetly-minister-gating-design.md`

Implementation plans (in `docs/superpowers/plans/`):

| File                                              | Scope                        |
|---------------------------------------------------|------------------------------|
| `2026-06-12-discreetly-v2-foundation.md`          | Plan 1 - monorepo skeleton, shared packages, Prisma |
| `2026-06-13-discreetly-v2-crypto-port.md`         | Plan 2 - crypto package, RLN prove/verify |
| `2026-06-14-discreetly-v2-backend-gate.md`        | Plan 3a/b - Minister gate, membership, ban |
| `2026-06-14-discreetly-v2-admin-backend.md`       | Plan 3c - admin control plane |
| `2026-06-14-discreetly-v2-backend-messaging.md`   | Plan 3d - message pipeline, Redis pub/sub |
| `2026-06-14-discreetly-v2-frontend.md`            | Plan 4 - frontend, admin UI, e2e |

| `2026-06-15-discreetly-v2-ci-deploy.md`           | Plan 5 - CI/deploy, Dockerfiles, prod compose |

Plan 6 (hardening) is upcoming and not yet committed.

---

## Conventions

- TypeScript strict mode: `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `verbatimModuleSyntax`
- Formatting: Prettier (root `pnpm format`); `.prettierignore` excludes
  `pnpm-lock.yaml`, build outputs, and circuit artifacts
- No empty catches, no swallowed errors
- Secrets only in gitignored `.env` / `apps/web/.env.local` - never in code
- Touch only the files a task needs; do not reformat unrelated code
