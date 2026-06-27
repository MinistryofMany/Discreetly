import { describe, it, expect } from 'vitest';
import type { PolicyNode } from '@discreetly/policy';
import { encodeMinisterPolicy, decodeMinisterPolicy } from './minister-policy.js';

describe('encodeMinisterPolicy / decodeMinisterPolicy', () => {
  it('round-trips a single-leaf policy', () => {
    const policy: PolicyNode = { badge: { type: 'age-over-18' } };
    const encoded = encodeMinisterPolicy(policy);
    expect(encoded).not.toBeNull();
    expect(decodeMinisterPolicy(encoded!)).toEqual(policy);
  });

  it('round-trips an anyOf (OR) policy', () => {
    const policy: PolicyNode = {
      anyOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    };
    const encoded = encodeMinisterPolicy(policy);
    expect(decodeMinisterPolicy(encoded!)).toEqual(policy);
  });

  it('round-trips a nested allOf[anyOf, leaf] policy with constraints', () => {
    const policy: PolicyNode = {
      allOf: [
        {
          anyOf: [
            { badge: { type: 'age-over-18', where: { threshold: 18 } } },
            { badge: { type: 'oauth-account', maxAgeDays: 30 } },
          ],
        },
        { badge: { type: 'residency-country' } },
      ],
    };
    const encoded = encodeMinisterPolicy(policy);
    expect(decodeMinisterPolicy(encoded!)).toEqual(policy);
  });

  it('round-trips an atLeast policy', () => {
    const policy: PolicyNode = {
      atLeast: {
        n: 2,
        of: [
          { badge: { type: 'age-over-18' } },
          { badge: { type: 'residency-country' } },
          { badge: { type: 'oauth-account' } },
        ],
      },
    };
    const encoded = encodeMinisterPolicy(policy);
    expect(decodeMinisterPolicy(encoded!)).toEqual(policy);
  });

  it('produces a URL-safe value (no +, /, or = padding)', () => {
    // A payload long enough to force base64 padding/special chars in the raw form.
    const policy: PolicyNode = {
      allOf: Array.from({ length: 5 }, (_, i) => ({ badge: { type: `type-${i}` } })),
    };
    const encoded = encodeMinisterPolicy(policy)!;
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('decodeMinisterPolicy returns null on malformed input (fail-closed)', () => {
    expect(decodeMinisterPolicy('not!base64!')).toBeNull();
    // Valid base64url but not JSON.
    expect(decodeMinisterPolicy('YWJj')).toBeNull(); // "abc"
  });

  it('encodeMinisterPolicy returns null when the policy cannot be serialized (fail-closed)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(encodeMinisterPolicy(circular as unknown as PolicyNode)).toBeNull();
  });
});
