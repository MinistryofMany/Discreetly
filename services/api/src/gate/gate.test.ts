import { describe, it, expect } from 'vitest';
import { createLocalJWKSet } from 'jose';
import { makeVerifier } from '../minister/verify.js';
import { evaluateGate } from './gate.js';
import {
  jwks,
  signIdToken,
  MOCK_ISSUER,
  MOCK_VC_ISSUER,
  MOCK_CLIENT_ID,
} from '../test/mock-issuer.js';
import type { PolicyNode } from '@discreetly/policy';

const verify = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  vcIssuer: MOCK_VC_ISSUER,
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
});
