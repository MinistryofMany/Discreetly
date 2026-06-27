import { describe, it, expect } from 'vitest';
import { createLocalJWKSet } from 'jose';
import { makeVerifier } from '../minister/verify.js';
import { evaluateGate } from './gate.js';
import {
  jwks,
  signIdToken,
  MOCK_ISSUER,
  MOCK_CLIENT_ID,
} from '../test/mock-issuer.js';
import type { PolicyNode } from '@discreetly/policy';

const verify = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  jwks: createLocalJWKSet(await jwks()),
});
const policy: PolicyNode = {
  allOf: [
    { badge: { type: 'email-domain', where: { domain: 'acme.com' } } },
    { badge: { type: 'invite-code' } },
  ],
};

describe('evaluateGate', () => {
  it('passes when badges satisfy the policy and returns the join nullifier', async () => {
    const idToken = await signIdToken({
      sub: 'sub-1',
      badges: [
        { type: 'email-domain', attributes: { domain: 'acme.com' } },
        { type: 'invite-code', attributes: { label: 'x' } },
      ],
    });
    const res = await evaluateGate({
      idToken,
      rlnIdentifier: 700n,
      policy,
      verify,
      now: 1_750_000_000,
    });
    expect(res.allowed).toBe(true);
    expect(res.joinNullifier).toBeTypeOf('bigint');
    expect(res.sub).toBe('sub-1');
  });
  it('denies when a required badge is missing', async () => {
    const idToken = await signIdToken({
      sub: 'sub-2',
      badges: [{ type: 'email-domain', attributes: { domain: 'acme.com' } }],
    });
    const res = await evaluateGate({
      idToken,
      rlnIdentifier: 700n,
      policy,
      verify,
      now: 1_750_000_000,
    });
    expect(res.allowed).toBe(false);
  });
  it('denies (fail-closed) when the stored policy is malformed', async () => {
    const idToken = await signIdToken({
      sub: 'sub-malformed',
      badges: [{ type: 'email-domain', attributes: { domain: 'acme.com' } }],
    });
    const res = await evaluateGate({
      idToken,
      rlnIdentifier: 700n,
      policy: {} as unknown as PolicyNode,
      verify,
      now: 1_750_000_000,
    });
    expect(res.allowed).toBe(false);
  });

  it('returns the verified token badge types (deduped) for recording', async () => {
    const idToken = await signIdToken({
      sub: 'sub-types',
      badges: [
        { type: 'email-domain', attributes: { domain: 'acme.com' } },
        { type: 'invite-code', attributes: { label: 'x' } },
      ],
    });
    const res = await evaluateGate({ idToken, rlnIdentifier: 700n, policy, verify });
    expect([...res.tokenBadgeTypes].sort()).toEqual(['email-domain', 'invite-code']);
  });
});

describe('evaluateGate with the durable proven store', () => {
  // A bare type-only policy (no `where`/`maxAgeDays`) - the only kind the durable
  // store may satisfy (fork F-D).
  const bareAllOf: PolicyNode = {
    allOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
  };
  // A constrained policy: residency-country must be PT (a `where` predicate).
  const constrainedAllOf: PolicyNode = {
    allOf: [
      { badge: { type: 'age-over-18' } },
      { badge: { type: 'residency-country', where: { country: 'PT' } } },
    ],
  };

  it('admits a bare-type allOf when one leaf is in the token and the other is durably proven', async () => {
    const idToken = await signIdToken({
      sub: 'sub-A',
      badges: [{ type: 'age-over-18', attributes: { threshold: 18 } }],
    });
    const res = await evaluateGate({
      idToken,
      rlnIdentifier: 701n,
      policy: bareAllOf,
      verify,
      // residency-country was proven on a previous (now-expired) token.
      loadProvenTypes: async (sub) => (sub === 'sub-A' ? ['residency-country'] : []),
    });
    expect(res.allowed).toBe(true);
  });

  it('F-D: a CONSTRAINED leaf is NOT satisfied from the durable store -> deny', async () => {
    const idToken = await signIdToken({
      sub: 'sub-A',
      badges: [{ type: 'age-over-18', attributes: { threshold: 18 } }],
    });
    const res = await evaluateGate({
      idToken,
      rlnIdentifier: 701n,
      policy: constrainedAllOf,
      verify,
      // Even though residency-country is durably proven, the `where:{country:'PT'}`
      // predicate needs the live VC's attributes, which the store lacks.
      loadProvenTypes: async () => ['residency-country', 'age-over-18'],
    });
    expect(res.allowed).toBe(false);
  });

  it('F-D: the same constrained room admits when the live token carries the attribute', async () => {
    const idToken = await signIdToken({
      sub: 'sub-A',
      badges: [
        { type: 'age-over-18', attributes: { threshold: 18 } },
        { type: 'residency-country', attributes: { country: 'PT' } },
      ],
    });
    const res = await evaluateGate({
      idToken,
      rlnIdentifier: 701n,
      policy: constrainedAllOf,
      verify,
      loadProvenTypes: async () => [],
    });
    expect(res.allowed).toBe(true);
  });

  it('cross-sub isolation: sub=X proven set never satisfies a join verified as sub=Y', async () => {
    // Y presents only age-over-18; residency-country is proven for X, not Y.
    const provenBySub: Record<string, string[]> = { 'sub-X': ['residency-country'] };
    const idTokenY = await signIdToken({
      sub: 'sub-Y',
      badges: [{ type: 'age-over-18', attributes: { threshold: 18 } }],
    });
    const res = await evaluateGate({
      idToken: idTokenY,
      rlnIdentifier: 702n,
      policy: bareAllOf,
      verify,
      loadProvenTypes: async (sub) => provenBySub[sub] ?? [],
    });
    expect(res.allowed).toBe(false);
  });

  it('fails closed (deny) when loading the proven set throws', async () => {
    const idToken = await signIdToken({
      sub: 'sub-A',
      badges: [{ type: 'age-over-18', attributes: { threshold: 18 } }],
    });
    const res = await evaluateGate({
      idToken,
      rlnIdentifier: 701n,
      policy: bareAllOf,
      verify,
      loadProvenTypes: async () => {
        throw new Error('db down');
      },
    });
    expect(res.allowed).toBe(false);
  });
});
