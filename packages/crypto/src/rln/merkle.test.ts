import { describe, it, expect } from 'vitest';
import { computeRoot, buildGroup } from './merkle.js';

describe('computeRoot', () => {
  it('equals the group root as a bigint', () => {
    const leaves = [111n, 222n, 333n];
    expect(computeRoot(99n, leaves)).toBe(BigInt(buildGroup(99n, leaves).root));
  });
  it('is order-sensitive and deterministic', () => {
    expect(computeRoot(1n, [1n, 2n])).toBe(computeRoot(1n, [1n, 2n]));
    expect(computeRoot(1n, [1n, 2n])).not.toBe(computeRoot(1n, [2n, 1n]));
  });
});
