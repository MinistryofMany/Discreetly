import { deriveContextNullifier } from '@minister/nullifier';

/**
 * Per-room nullifier anchoring a Minister identity to a room.
 * Stable for (sub, room); unlinkable across rooms. ZK-friendly (Poseidon).
 *
 * This is now a thin wrapper over the shared `@minister/nullifier`
 * `deriveContextNullifier(sub, contextId)`, which is a verbatim generalization
 * of the former local implementation:
 *
 *   poseidon2([toField(sub), contextId % FIELD])
 *
 * with the SAME BN254 FIELD constant and the SAME big-endian base-256 `toField`
 * reduction. The mapping is `contextId = rlnIdentifier`, so the output is
 * BYTE-IDENTICAL to the old `joinNullifier(sub, rlnIdentifier)` for every input.
 * Existing membership/ban rows keyed on the old value therefore need no
 * migration. The byte-identical equality is asserted in `join-nullifier.test.ts`
 * here and in `@minister/nullifier`'s cross-impl golden-vector test.
 */
export function joinNullifier(sub: string, rlnIdentifier: bigint): bigint {
  return deriveContextNullifier(sub, rlnIdentifier);
}
