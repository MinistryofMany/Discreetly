# Plan 3 (backend) crypto-integration follow-ups

Surfaced during the crypto-port adversarial review. All were correctly judged not-a-bug for the crypto package itself (faithful-to-legacy or forward-looking), but each is a real consideration when the backend wires `@discreetly/crypto` into the message pipeline.

## 1. Bind the message epoch to the proof epoch

`verifyRLNProof` window-checks the caller-supplied `epoch` but does NOT assert it equals the proof's bound epoch. The RLN SNARK binds `externalNullifier` to `proof.epoch`; rlnjs verifies against `proof.epoch`, not the separately-passed `epoch`. The legacy had the identical gap, and its ephemeral collision store keyed on the unbound `message.epoch`, so a crafted `message.epoch != proof.epoch` could side-step dedup.

When building the message handler:
- Either assert `message.epoch === proof.epoch` (i.e. `BigInt(proof.snarkProof.publicSignals.externalNullifier)` corresponds to the claimed epoch) before accepting, OR
- Key the collision/dedup store on `proof.epoch` (the bound value), never a client-supplied epoch field.

Cheap hardening over legacy; close it in the v2 pipeline.

## 2. `verifyRLNProof` can THROW, not just return false

rlnjs `RLNVerifier.verifyProof` **throws** ("External nullifier does not match…") when a proof's `epoch`/`rlnIdentifier` don't match the recomputed external nullifier — it does not return `false`. So `verifyRLNProof` rejects its promise on that class of tamper (the early `return false` branches only cover epoch-window / signal-hash / root mismatches). The legacy relied on this: it wrapped the whole verify chain in try/catch at `server/src/websockets/index.ts` and treated a throw as "reject the message."

In Plan 3: the caller MUST wrap `verifyRLNProof` in try/catch and treat a throw as an invalid message. Add a test that tampers `proof.epoch` and asserts the caller handles the rejection (the crypto round-trip test only exercises the `return false` paths).

## 3. Consumer TypeScript resolution (TS7016) — needs a central fix

Consumers of `@discreetly/crypto` (the Plan 3 Node backend, the Plan 4 frontend) will fail `tsc` with TS7016 on **both** `ffjavascript` **and** `@semaphore-protocol/group`/`identity`, because:
- crypto ships source (`main`/`types`/`exports` → `./src/index.ts`), so consumers typecheck crypto's `.ts` in their own program;
- the ambient `src/types/ffjavascript.d.ts` shim is loaded only by crypto's own tsconfig `include` and does NOT transit to consumers;
- `@semaphore-protocol/group@3.10.1` / `identity@3.15.0` and `ffjavascript@0.2.60` have `exports` maps with no `types` condition, so under `moduleResolution: "Bundler"` TS can't find their `.d.ts` despite it existing at `dist/types/index.d.ts`.

The per-consumer `paths` override that crypto carries is **necessary but NOT sufficient** for consumers — a consumer with only the semaphore `paths` override still fails on `ffjavascript` (it also needs the ambient shim).

Central fix options (decide when the first consumer lands):
- A shared ambient-types package (e.g. `@discreetly/types`) holding the `ffjavascript` + semaphore module declarations, referenced by every consumer; or
- `pnpm.patchedDependencies` to inject a `types` condition into the semaphore/ffjavascript `exports`; or
- replicate BOTH the `paths` override AND the ffjavascript ambient in each consumer's tsconfig (last resort, duplicative).

Also consider shrinking crypto's public type surface: it currently leaks `@semaphore-protocol`'s `Group` type via `buildGroup()` and `merkleProofForLeaf()` return types. Adding a `computeRoot(rlnIdentifier, leaves): bigint` helper (so the verify-side backend never touches the `Group` type) would cut a consumer's exposure from three modules to one (`ffjavascript`, via `shamirRecovery`).

**Resolved in 3a:** `computeRoot` added to `packages/crypto/src/rln/merkle.ts` to avoid the Group-type leak on the verify side; the `ffjavascript` ambient now lives in `@discreetly/shared/src/types/external-shims.d.ts`; consumers add that path to their tsconfig `include` (and the `@semaphore-protocol` `paths` only if they import `buildGroup`/`merkleProofForLeaf`).
