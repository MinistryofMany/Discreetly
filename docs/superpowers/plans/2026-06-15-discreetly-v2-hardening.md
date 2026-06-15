# Discreetly v2 — Hardening (Plan 6) Implementation Plan

> **For agentic workers:** executed by tiered subagents from the orchestrator. Request-path + security work is opus floor.

**Goal:** Production-harden the API surface: per-IP abuse rate limiting (HTTP + WS), structured logging with secret redaction, health/readiness endpoints, a safe tRPC error formatter, base-image digest pinning, and a full read-only security audit of the entire v2 surface with a fix loop.

**Constraints:** Rate limits and logging must NOT break the existing test suites or the 20 Playwright e2e specs - make limits env-configurable with generous defaults and a test override. RLN already rate-limits messages cryptographically; this plan adds transport-layer (IP) protection against join/connection/query floods. The API is multi-instance-capable (Redis pub/sub), so the rate limiter should be Redis-backed to be correct across instances. Postgres 5432 + Redis 6379 dev containers are up. Do NOT run Docker smoke tests concurrently with `pnpm test` (shared dev DB causes flakes).

---

## Task 1 (engineer / opus): Rate limiting + structured logging + health + error formatter

**Files:** `services/api/src/server.ts`, `services/api/src/config.ts`, new `services/api/src/middleware/rate-limit.ts`, new `services/api/src/log.ts`, `services/api/src/trpc/trpc.ts` (error formatter), `services/api/src/realtime/{broadcast,redis}.ts` (logging), `services/api/src/messaging/pipeline.ts` (logging), plus tests. Add deps `pino` (logging) - no heavy frameworks.

- **Structured logging (`log.ts`):** a `pino` logger with level from `LOG_LEVEL` (default `info`), pretty in dev. A `redact` config that strips `id_token`, `idToken`, `authorization`, `password`, `secret`, `code_verifier`, `shamirSecret` from logged objects. Replace the `console.log`/`console.error` in `server.ts` and `broadcast.ts` with the logger. Never log raw tokens/secrets/message plaintext.
- **Rate limiting (`rate-limit.ts`):** a Redis-backed fixed/sliding-window limiter (use the existing ioredis `publisher()` client or a dedicated client; a small atomic Lua INCR+EXPIRE or `MULTI`). Config via env: `RATE_LIMIT_WINDOW_MS` (default 60000), `RATE_LIMIT_MAX` (default e.g. 120/min/IP for general), and a stricter bucket for mutations (`RATE_LIMIT_MUTATION_MAX`, default e.g. 30/min/IP). A master switch `RATE_LIMIT_ENABLED` (default true) that tests/e2e set to false (or set very high limits) so they do not flake.
  - HTTP: in the `createHTTPServer` middleware, derive the client IP (document the proxy-trust assumption: use the leftmost `x-forwarded-for` only when behind a trusted proxy, else the socket remote address; make trust configurable via `TRUST_PROXY`), apply the limiter, return HTTP 429 with a `Retry-After` header on exceed. Apply the stricter mutation bucket to POST tRPC calls (mutations) and a looser bucket to GET (queries). Keep the existing CORS/OPTIONS behavior.
  - WS: in `verifyClient`, additionally cap concurrent connections per IP and the new-connection rate per IP (reject with 429/1013). Keep the existing Origin allowlist.
- **Health/readiness:** in the HTTP middleware, before tRPC, handle `GET /health` (process up -> 200) and `GET /ready` (checks Postgres `SELECT 1` + Redis `PING` -> 200, else 503). Wire the `docker-compose.prod.yml` / Dockerfile healthcheck to `/health` (or `/ready`) instead of any ad-hoc check.
- **tRPC error formatter:** configure `initTRPC...create({ errorFormatter })` so internal error messages/stacks are not leaked to clients in production (keep the tRPC `code` and zod flattened errors; suppress raw `message`/stack for `INTERNAL_SERVER_ERROR` when `NODE_ENV==='production'`). Log the full error server-side via pino.

**Tests:** unit-test the rate limiter (allows under limit, 429s over limit, window resets, separate buckets) using the dev Redis; test the error formatter redaction; test `/health` + `/ready`. Keep ALL existing api tests green (94 + 3 skipped). Ensure the e2e still passes with rate limiting (set the e2e harness env to disable or greatly raise limits).

**Verify:** `pnpm --filter @discreetly/api test` + `typecheck`; then run the full Playwright e2e (`pnpm --filter @discreetly/web exec playwright test`) and confirm all 20 specs still pass with the new middleware in the API path (the harness must set the rate-limit override). Do NOT run Docker builds concurrently with these test runs.

## Task 2 (implementer / sonnet): Base-image digest pinning (deferred Plan 5 LOW)

Pin the base images by `@sha256:` digest in `services/api/Dockerfile`, `apps/web/Dockerfile`, and the `postgres`/`redis` images in `docker-compose.prod.yml` (resolve current digests for `node:20-bookworm-slim`, `postgres:16`, `redis:7`). Keep a comment with the human-readable tag next to each digest. Rebuild both images to confirm they still build. (If digest resolution is not possible offline, document the exact tags + a note to pin on first registry access - do not block.)

## Task 3 (auditor / opus xhigh, read-only): Full v2 security audit + fix loop

A comprehensive read-only audit of the ENTIRE v2 surface (not just a diff): `services/api/**`, `packages/{crypto,policy,db}/**`, `apps/web/**`, the Docker/compose/CI. Prioritize: crypto correctness (RLN verify, Shamir ban recovery, join-nullifier, signal hash, no nonce/IV reuse), auth/authz (the gate, read-access, adminProcedure, the join/rotate/ban paths, no privilege bypass or IDOR), token handling (no leakage), input validation (zod coverage, policy validation fail-closed), the rate-limit/DoS posture from Task 1, secret/key management, and data exposure (passwordHash, shamirSecret, identity confinement). Return prioritized findings.

Then the orchestrator triages: fix CRITICAL/HIGH/justified-MEDIUM via engineer (crypto/security) or implementer (mechanical), re-audit/re-test, and document any accepted residual risk.

## Final review
- All package `typecheck` + `test` + the 20 e2e green. `pnpm format`.
- Merge `plan-6-hardening` -> `main`.

## Self-review notes
- Rate limits + logging must be invisible to the test/e2e flows (env override) - verify e2e stays 20/20.
- Redis-backed limiter keeps multi-instance correctness (matches the stateless-scale design).
- The full audit is the user's requested final security pass; treat its CRITICAL/HIGH as merge blockers.
