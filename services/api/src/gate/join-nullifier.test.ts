import { describe, it, expect } from 'vitest';
import { poseidon2 } from 'poseidon-lite';
import { joinNullifier } from './join-nullifier.js';

const FIELD = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

/**
 * The OLD local implementation, frozen here verbatim as the migration baseline.
 * `joinNullifier` now delegates to `@ministryofmany/nullifier.deriveContextNullifier`,
 * and existing Discreetly membership/ban rows are keyed on this old value, so
 * the new derivation MUST be byte-identical to this for every input or it would
 * silently change the nullifier namespace and orphan those rows.
 */
function oldToField(s: string): bigint {
  let acc = 0n;
  for (const byte of new TextEncoder().encode(s)) acc = (acc * 256n + BigInt(byte)) % FIELD;
  return acc;
}
function oldJoinNullifier(sub: string, rlnIdentifier: bigint): bigint {
  return poseidon2([oldToField(sub), rlnIdentifier % FIELD]);
}

describe('joinNullifier', () => {
  it('is deterministic per (sub, room) and field-bounded', () => {
    const a = joinNullifier('sub-abc', 700n);
    expect(joinNullifier('sub-abc', 700n)).toBe(a);
    expect(a).toBeLessThan(FIELD);
  });
  it('differs across subs and across rooms (per-room unlinkable)', () => {
    expect(joinNullifier('sub-a', 700n)).not.toBe(joinNullifier('sub-b', 700n));
    expect(joinNullifier('sub-a', 700n)).not.toBe(joinNullifier('sub-a', 701n));
  });
});

describe('joinNullifier byte-identity with the pre-refactor implementation', () => {
  // No data migration is needed only if the shared derivation reproduces the
  // old local one bit-for-bit. Cover several inputs incl. a long sub and a
  // contextId (rlnIdentifier) larger than FIELD (must wrap to the same anchor).
  it('matches oldJoinNullifier for every sample (incl. long sub and contextId > FIELD)', () => {
    const cases: Array<[string, bigint]> = [
      ['sub-abc', 700n],
      ['pairwise-user-123', 42n],
      ['', 0n],
      ['a longer pairwise subject value with spaces and digits 0123456789', 123456789n],
      ['sub-with-unicode-café-✓', FIELD + 9n],
      ['x'.repeat(512), FIELD * 3n + 17n],
    ];
    for (const [sub, ctx] of cases) {
      expect(joinNullifier(sub, ctx)).toBe(oldJoinNullifier(sub, ctx));
    }
  });
});
