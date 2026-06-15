# Discreetly v2 — CI + Deploy (Plan 5) Implementation Plan

> **For agentic workers:** executed by tiered subagents from the orchestrator. DevOps/infra: verify by BUILDING and RUNNING, not just authoring YAML.

**Goal:** Make the monorepo deployable and CI-guarded: production Dockerfiles for `services/api` and `apps/web`, a production `docker-compose`, a GitHub Actions CI pipeline, and the durable internal-package type story documented/closed. Verify images actually boot and serve.

**Constraints:** The repo has no git remote yet, so GitHub Actions cannot execute on a server; the workflow is authored and its steps verified by running them locally. The API runs via `tsx` (no build step) and needs the Prisma client generated. Next needs `output: 'standalone'`. Minister is an external OIDC provider (host process on :3000); the API points at it via env (`MINISTER_*`). Postgres 5432 + Redis 6379 dev containers are up via the existing `docker-compose.yml` (do not break it).

---

## Task 1 (engineer / opus): Production Dockerfiles + .dockerignore

- `apps/web/next.config.mjs`: add `output: 'standalone'` and `outputFileTracingRoot` = the monorepo root (so standalone traces the workspace TS packages). Keep all existing config (transpilePackages, webpack extensionAlias, asyncWebAssembly, circuits browser stub, security headers/CSP).
- `services/api/Dockerfile`: Node 20 + corepack pnpm. Copy the workspace, `pnpm install --frozen-lockfile`, generate the Prisma client (`pnpm --filter @discreetly/db generate`). Runtime CMD = `pnpm --filter @discreetly/api start` (tsx). Expose 3002. Use a multi-stage layout (deps cache layer) but the runtime must keep `tsx` + the workspace TS source (the API has no compiled output). Health: the server logs and listens on `API_PORT`.
- `apps/web/Dockerfile`: multi-stage. Builder: `pnpm install --frozen-lockfile`, ensure the circuit artifacts are copied into `public/circuits/rln/` (the `prebuild` script does this), `pnpm --filter @discreetly/web build`. Runner: copy `.next/standalone`, `.next/static`, and `public` (incl. circuits); run `node apps/web/server.js` (or the standalone entry). Expose 3001. Env: `MINISTER_*`, `AUTH_*`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_API_WS_URL` (note: `NEXT_PUBLIC_*` are build-time-inlined, so they must be provided at build for the prod image, or documented as such).
- Root `.dockerignore`: `node_modules`, `**/node_modules`, `.next`, `.turbo`, `dist`, `_legacy`, `.git`, `.worktrees`, `test-results`, `playwright-report`, `.env`, `.env.*`, `apps/web/.env.local`.

**Verify (MANDATORY):** `docker build` both images successfully. Then run the api image against the dev Postgres/Redis (host networking or `host.docker.internal`, with the `MINISTER_*` env from `.env`) and confirm it serves (`curl` a tRPC endpoint or the HTTP root returns a response, WS port open). Build + run the web image and `curl http://localhost:<port>/` returns the sign-in HTML. Report image sizes + the smoke-test output. Tear down test containers.

## Task 2 (engineer / opus): Production docker-compose

- `docker-compose.prod.yml`: services `postgres`, `redis`, `api` (build `services/api/Dockerfile`), `web` (build `apps/web/Dockerfile`), wired with env, `depends_on` healthchecks, an internal network, and a one-shot `migrate` step (`prisma migrate deploy`) before the API starts (or an entrypoint that runs migrate deploy). Make `MINISTER_ISSUER`/`MINISTER_JWKS_URL`/`MINISTER_VC_ISSUER`/`MINISTER_CLIENT_ID`/`MINISTER_CLIENT_SECRET` and `AUTH_*` configurable via a `.env`-style file (document `host.docker.internal:3000` for reaching the host Minister in local prod). `ALLOWED_WS_ORIGINS` must include the web origin. Do NOT clobber the dev `docker-compose.yml`.
- A `.env.prod.example` documenting every required variable (no secrets).

**Verify (MANDATORY):** `docker compose -f docker-compose.prod.yml up -d --build` (use non-conflicting host ports if 5432/6379 are taken by the dev stack), wait for healthy, then smoke-test: api responds, web serves the home page, and a public-room query works end to end (web -> api -> postgres). Report the result. Tear down (`down -v`).

## Task 3 (implementer / sonnet): GitHub Actions CI

- `.github/workflows/ci.yml`: trigger on push + pull_request. Use pnpm + Node 20 with pnpm store caching. Postgres 16 + Redis 7 service containers. Steps: `pnpm install --frozen-lockfile`; write a CI `.env` (DATABASE_URL -> the postgres service, REDIS_URL -> redis service, MINISTER_* test values, ALLOWED_WS_ORIGINS) so the dotenv-based test scripts and `getConfig()` validation work; `prisma migrate deploy` (or `db push`) to set up the schema; `pnpm typecheck`; `pnpm lint`; `pnpm test` (turbo - unit suites; live-Minister tests skip with no `MINISTER_DEV_DATABASE_URL` and unreachable discovery); `pnpm --filter @discreetly/web build`. A SEPARATE job for e2e: install Playwright chromium, the e2e harness self-hosts the mock OIDC + API + web and creates the `discreetly_e2e` DB, so it needs only postgres+redis services + the env; run `pnpm --filter @discreetly/web exec playwright test`; upload the Playwright report artifact on failure.
- Because there is no remote, VERIFY by running the exact command sequence locally (typecheck, lint, test, build, e2e all already pass locally) and by validating the YAML (parse it). Clearly note in the plan/report that the workflow is authored + locally-verified but has not executed on GitHub (no remote).

## Task 4 (orchestrator/implementer): Durable type story + scaling notes

- The TS2589 drift risk was addressed in Plan 4 by `services/api/src/trpc/outputs.ts` (explicit `PublicRoom`/`AdminRoom` output types re-exported from `@discreetly/api`, consumed by the web). Confirm this is the durable answer (no remaining hand-maintained shape duplication that can silently drift); if any `inferRouterOutputs`-deep issue remains, add an `expectTypeOf` drift-assertion test. Document the internal-package resolution decision (TS-source + transpilePackages/tsx + ambient shims) in `CLAUDE.md` if not already covered.
- Add a short "Scaling + no-lock-in" section to `README.md` or a `docs/` note: the API is stateless (state in Postgres + Redis), Redis pub/sub fans broadcasts across instances, so it scales horizontally behind a load balancer with a Postgres connection pooler (PgBouncer/Supavisor); message-table partitioning by room+time is the growth path. (Documentation, not new infra.)

## Final review
- `pnpm typecheck` + `pnpm test` + e2e still green. auditor (opus) over the Docker/compose/CI for secret leakage (no secrets baked into images, `.env*` dockerignored, no secret in the workflow), least-privilege, and image hygiene. Fix-loop. Merge `plan-5-ci-deploy` -> `main`.

## Self-review notes
- "Fully tested" for infra = images build and boot and serve (verified locally); CI commands verified locally even though GitHub cannot run them (no remote).
- Do not break the dev `docker-compose.yml` (ports 5432/6379 the dev + e2e flows depend on).
- Secrets stay in gitignored env files; `.dockerignore` must exclude `.env*` and `apps/web/.env.local`.
