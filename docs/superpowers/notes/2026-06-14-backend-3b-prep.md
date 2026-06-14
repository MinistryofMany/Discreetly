# Backend 3b prep — deferred items from the 3a review

The 3a holistic review confirmed two MINOR items that were deliberately deferred (reviewer agreed both are deferrable). Address them at the START of 3b, before building the message pipeline, since 3b will touch the same areas.

## 1. Lazy config + move the production verifier out of `verify.ts` (test hygiene)

`services/api/src/config.ts` runs `loadConfig()` eagerly at import (`export const config = loadConfig()`), and `services/api/src/minister/verify.ts` co-locates the production singleton `verifyMinisterIdToken = makeVerifier({...config..., createRemoteJWKSet...})` with the injectable `makeVerifier` factory. So importing `verify.ts` for any reason transitively parses full env + binds a remote JWKS. Unit tests pass only because the `test` script injects `../../.env` via dotenv; without it, 6/8 api test files fail at collection.

Fix:
- `config.ts`: replace the eager export with a memoized getter — `let cached: Config | undefined; export function getConfig(): Config { return (cached ??= loadConfig()); }`.
- Move the production verifier into a composition-root module (e.g. `src/minister/production-verifier.ts` exporting `getProductionVerifier()` built from `getConfig()`), leaving `verify.ts` exporting only `makeVerifier` + types.
- Update `server.ts` (`createContext: () => ({ verify: getProductionVerifier() })`) and `verify.live.test.ts` to use it.

Result: `verify.ts` (and `makeVerifier`) import with zero env; env is required only at the runtime entrypoint.

## 2. Crypto subpath exports — drop the `@semaphore-protocol` phantom dep (dependency hygiene)

`@discreetly/api` imports only `getRateCommitmentHash` (from `crypto/field.ts`, poseidon-only), but through the barrel `@discreetly/crypto`, whose `src/index.ts` re-exports `./rln/index.js` → `merkle.ts`/`prover.ts`, which import `@semaphore-protocol/group`. That forced api to add a **phantom** `@semaphore-protocol/group` dependency it never calls + a `paths` override in `tsconfig.json` (and a separate `tsconfig.server.json` without it for tsx). Root cause: `@semaphore-protocol/group@3.10.1`/`identity@3.15.0` ship `exports` maps with no `types` condition, so TS can't resolve their types under `moduleResolution: "Bundler"`.

Fix (empirically validated by the reviewer):
- In `packages/crypto/package.json` add an exports map: `{ ".": "./src/index.ts", "./rln": "./src/rln/index.ts" }`.
- In `packages/crypto/src/index.ts` remove `export * from './rln/index.js'` so the default barrel carries only field/signal-hash/shamir (no Semaphore).
- Then in `services/api`: drop the `@semaphore-protocol/group` dependency and the `paths` override (and the now-unneeded `tsconfig.server.json` split). Verified: api typechecks clean afterward; crypto still typechecks.
- RLN-proof / root-computing consumers (3b's message pipeline needs `verifyRLNProof` + `computeRoot`, and Plan 4's frontend needs the prover) import from `@discreetly/crypto/rln` and carry the Semaphore resolution. For those, prefer adding a `@semaphore-protocol/group` (+ `identity`) ambient shim to `packages/shared/src/types/external-shims.d.ts` (already used for `ffjavascript`) so the brittle node_modules-relative `paths` pointer can be dropped everywhere rather than duplicated per consumer.

Also: `merkle.ts` leaks the `Group` type via `buildGroup(): Group` and `ReturnType<Group['generateMerkleProof']>`. Keep an eye on this for Plan 4 browser bundling (a verify-only client shouldn't bundle the Group-using prover/merkle). Re-evaluate when wiring the frontend.

## Also remember in 3b (from the crypto-integration note)
- Bind `message.epoch === proof.epoch` (or key the collision store on `proof.epoch`) — the epoch-spoofing gap.
- `verifyRLNProof` can THROW on epoch/identifier tamper — wrap the message-handler call in try/catch and treat a throw as "reject message" (like the legacy did at `websockets/index.ts`).
