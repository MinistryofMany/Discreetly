# ZK Non-Authorship Moderation — Prototype

> **THIS IS AN OFF, EXPLORATORY PROTOTYPE. IT IS NOT WIRED INTO DISCREETLY.**
> Nothing here touches the live `Discreetly` app, its send/verify path, its
> circuits, its database, or its config. It is a self-contained research
> artifact that validates the circuit design in
> `../DESIGN.md` (sections 10.2 and 10.5). Do not deploy, import, or enable any
> of it. See `DESIGN.md` §0, §9, and §11 — the product may not want content
> bans at all, and for ephemeral rooms the scheme is structurally inapplicable.

## What this proves

The core claim of the scheme, demonstrated with a real Groth16 proof on a real
compiled circuit:

> Given a message tag `T_M`, a **non-author** (different secret, valid Merkle
> membership) produces a **VALID** non-authorship proof, while the **AUTHOR**
> (whose tag equals `T_M`) **CANNOT** — the circuit is unsatisfiable and witness
> generation fails for them.

The test (`test/run.mjs`) exercises six checks and all pass (real output below):

```
[single] trusted setup (groth16/bn128)...
  PASS  non-author produces a VALID non-authorship proof (cn matches)
  PASS  author CANNOT generate a witness (constraint unsatisfiable): Error: Assert Failed.
  PASS  control: the SAME member is a valid non-author of a DIFFERENT message (failure was the tag, not membership)
  PASS  control: a NON-MEMBER cannot clear (membership binding holds)

[batch] trusted setup (groth16/bn128)...
  PASS  non-author clears the whole BATCH in one VALID proof (cn matches)
  PASS  author of a batch entry CANNOT clear the batch: Error: Assert Failed.

ALL CHECKS PASSED
```

- **Author fails** because the non-equality gadget `(myTag - authorTag) * inv === 1`
  has no satisfying `inv` when `myTag == authorTag` (DESIGN.md §10.4). The witness
  calculator reports `Assert Failed`.
- The two **controls** prove the author's failure is *specifically* the tag
  inequality, not a broken membership path: the same member secret clears a
  *different* message they did not write, and a non-member (secret not in the
  tree) is rejected even with a non-equal tag (membership binding, DESIGN.md §4.4).

## Circuits

| File | DESIGN.md ref | Public inputs | Public outputs | Constraints (r1cs) |
| --- | --- | --- | --- | --- |
| `circuits/nonauthorship.circom` | §10.2 (single message) | `root, idM, authorTag, userMessageLimit, challengeId` | `cn = Poseidon(s, challengeId)` | 12,476 |
| `circuits/nonauthorship_batch.circom` | §10.5 (BATCH-A, K=4) | `root, userMessageLimit, challengeBatchId, setDigest, idM[K], e[K]` | `cn = Poseidon(s, challengeBatchId)` | 18,793 |

Both are Circom 2 / Groth16 / BN254 / Poseidon, matching the deployed
`rlnjs`/`snarkjs`/`circomlib` stack and a depth-20 Merkle tree
(`MERKLE_TREE_DEPTH = 20`, same as `packages/crypto/src/rln/merkle.ts`).

### Convention matching (verified against `Discreetly/packages/crypto`)

- `idc = Poseidon(s)`; `rc = Poseidon(idc, userMessageLimit)` (the tree leaf) —
  matches `getRateCommitmentHash` / `getIdentityCommitmentFromSecret`.
- Merkle path uses Poseidon(2) with `pathIndices`-bit left/right ordering, the
  same `@semaphore-protocol/group` v3.10.1 incremental Merkle tree the live code
  uses. The test builds the tree and proof with that exact library, so a valid
  proof is itself evidence the in-circuit hashing matches the JS hashing.
- `T_M = Poseidon(TAG_DOMAIN, s, idM)` with
  `TAG_DOMAIN = keccak256("discreetly/nonauth/v1") >> 8  (mod p)`
  `= 422115546466166259619571466461604094994863187710345308661988695711865692286`
  (computed via `@ethersproject/keccak256`, pinned as a circuit constant).
- Batched: `e_i = Poseidon(idM_i, T_Mi)`, `d_i(s) = Poseidon(idM_i, Poseidon(TAG_DOMAIN, s, idM_i))`,
  innocence ⇔ `d_i ≠ e_i` for all enabled `i` (DESIGN.md §6.3). `setDigest` is a
  Poseidon-fold over `{(idM_i, e_i)}` (replay-safety, §6.5). Disabled padding
  slots are gated with `enabled_i * ((d_i - e_i)*inv_i - 1) === 0` (§10.5).

> **Not implemented here:** the augmented send proof (Statement S, §3.1/§10.7),
> `SeatPresence` (R1 roll-call, §10.3), and BATCH-B (Plonkish LogUp, §10.6).
> The single + batched non-authorship circuits are the core moderation claim;
> the others are noted in DESIGN.md and out of scope for this prototype.

## Toolchain (this ran on a NixOS host)

- **circom 2.2.3** via `nix shell nixpkgs#circom` (not on PATH by default here).
- **snarkjs 0.7.6** + **circomlib 2.0.5** + **poseidon-lite 0.2.0** +
  **@semaphore-protocol/group 3.10.1** + **@ethersproject/keccak256/strings**,
  installed locally via `npm install` (see `package.json`). These mirror the
  versions in `Discreetly/packages/crypto`.
- Node 24.

## How to build + run

```sh
cd prototype
npm install

# compile both circuits (circom comes from nixpkgs)
nix shell nixpkgs#circom -c circom circuits/nonauthorship.circom       --r1cs --wasm --sym -o build
nix shell nixpkgs#circom -c circom circuits/nonauthorship_batch.circom --r1cs --wasm --sym -o build

# run the e2e test (does a throwaway groth16 trusted setup, proves, verifies)
node test/run.mjs
```

The test performs an in-process powers-of-tau + per-circuit zkey ceremony
(throwaway entropy — **not** a real ceremony; fine for a prototype) at power 16,
generates witnesses, produces Groth16 proofs for the non-author cases, verifies
them, and asserts the author cases fail witness generation. First run downloads
circom from the Nix cache and runs the ptau ceremony (slowest step); reruns
reuse the cached `build/*.ptau` and zkeys.

## Layout

```
prototype/
  README.md                         (this file)
  package.json                      (local deps; "type":"module")
  circuits/
    nonauthorship.circom            single-message NonAuthorship (DESIGN §10.2)
    nonauthorship_batch.circom      batched BATCH-A, K=4 (DESIGN §10.5)
  test/
    lib.mjs                         crypto + Merkle helpers (match packages/crypto)
    run.mjs                         e2e: setup, prove, verify, assert
  build/                            (generated; gitignored) r1cs/wasm/zkey/ptau
```

## Blockers / caveats

- `circom` is not in the default PATH on this host; it is fetched on demand from
  nixpkgs (`nix shell nixpkgs#circom`). No system install was needed.
- The trusted setup uses throwaway entropy — correct for a prototype, **never**
  for production.
- This validates the **moderation** circuits only. A real deployment also needs
  the send-time Statement S binding (§3.1) without which the author could disown
  the tag; that is noted here but not built.
