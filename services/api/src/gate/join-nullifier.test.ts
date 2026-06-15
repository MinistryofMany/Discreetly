import { describe, it, expect } from 'vitest';
import { joinNullifier } from './join-nullifier.js';

describe('joinNullifier', () => {
  it('is deterministic per (sub, room) and field-bounded', () => {
    const FIELD = BigInt(
      '21888242871839275222246405745257275088548364400416034343698204186575808495617',
    );
    const a = joinNullifier('sub-abc', 700n);
    expect(joinNullifier('sub-abc', 700n)).toBe(a);
    expect(a).toBeLessThan(FIELD);
  });
  it('differs across subs and across rooms (per-room unlinkable)', () => {
    expect(joinNullifier('sub-a', 700n)).not.toBe(joinNullifier('sub-b', 700n));
    expect(joinNullifier('sub-a', 700n)).not.toBe(joinNullifier('sub-a', 701n));
  });
});
