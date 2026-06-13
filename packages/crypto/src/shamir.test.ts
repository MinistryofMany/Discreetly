import { describe, it, expect } from 'vitest';
import { shamirRecovery, getIdentityCommitmentFromSecret } from './shamir.js';

describe('shamirRecovery (parity)', () => {
  it('recovers the secret (y-intercept) from two points in Fq', () => {
    expect(shamirRecovery(3n, 7n, 5n, 11n)).toBe(
      10944121435919637611123202872628637544274182200208017171849102093287904247809n,
    );
    expect(
      shamirRecovery(
        111111111111111111111n,
        222222222222222222222n,
        333333333333333333333n,
        555555555555555555555n,
      ),
    ).toBe(111111111111111111111n);
  });

  it('getIdentityCommitmentFromSecret', () => {
    expect(getIdentityCommitmentFromSecret(12345n)).toBe(
      4267533774488295900887461483015112262021273608761099826938271132511348470966n,
    );
  });
});
