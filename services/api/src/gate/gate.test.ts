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

describe('evaluateGate (inline, token-only)', () => {
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

  it('denies (fail-closed) when the id_token cannot be verified', async () => {
    const res = await evaluateGate({
      idToken: 'not-a-real-jwt',
      rlnIdentifier: 700n,
      policy,
      verify,
      now: 1_750_000_000,
    }).catch((e: unknown) => e);
    // verify throws on a bad token; the router maps that to a deny. The gate
    // itself does not swallow a verify failure (it is outside the try/catch), so
    // a thrown error here is the fail-closed signal.
    expect(res).toBeInstanceOf(Error);
  });

  it('admits a bare-type allOf only when BOTH leaves are in the live token', async () => {
    const bareAllOf: PolicyNode = {
      allOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    };
    // Only one of the two bare types is in the token -> deny (no durable union
    // can supply the other anymore).
    const idTokenOne = await signIdToken({
      sub: 'sub-A',
      badges: [{ type: 'age-over-18', attributes: { threshold: 18 } }],
    });
    expect(
      (
        await evaluateGate({
          idToken: idTokenOne,
          rlnIdentifier: 701n,
          policy: bareAllOf,
          verify,
        })
      ).allowed,
    ).toBe(false);

    // Both bare types in the token -> admit.
    const idTokenBoth = await signIdToken({
      sub: 'sub-A',
      badges: [
        { type: 'age-over-18', attributes: { threshold: 18 } },
        { type: 'residency-country', attributes: { country: 'PT' } },
      ],
    });
    expect(
      (
        await evaluateGate({
          idToken: idTokenBoth,
          rlnIdentifier: 701n,
          policy: bareAllOf,
          verify,
        })
      ).allowed,
    ).toBe(true);
  });

  it('a CONSTRAINED leaf admits only with a live VC carrying the attribute', async () => {
    const constrainedAllOf: PolicyNode = {
      allOf: [
        { badge: { type: 'age-over-18' } },
        { badge: { type: 'residency-country', where: { country: 'PT' } } },
      ],
    };
    // Live token has residency-country but with the WRONG country attribute -> deny.
    const idTokenWrong = await signIdToken({
      sub: 'sub-A',
      badges: [
        { type: 'age-over-18', attributes: { threshold: 18 } },
        { type: 'residency-country', attributes: { country: 'US' } },
      ],
    });
    expect(
      (
        await evaluateGate({
          idToken: idTokenWrong,
          rlnIdentifier: 701n,
          policy: constrainedAllOf,
          verify,
        })
      ).allowed,
    ).toBe(false);

    // Live token carries the matching attribute -> admit.
    const idTokenRight = await signIdToken({
      sub: 'sub-A',
      badges: [
        { type: 'age-over-18', attributes: { threshold: 18 } },
        { type: 'residency-country', attributes: { country: 'PT' } },
      ],
    });
    expect(
      (
        await evaluateGate({
          idToken: idTokenRight,
          rlnIdentifier: 701n,
          policy: constrainedAllOf,
          verify,
        })
      ).allowed,
    ).toBe(true);
  });
});
