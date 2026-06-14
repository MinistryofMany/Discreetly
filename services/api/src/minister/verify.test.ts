import { describe, it, expect } from 'vitest';
import { createLocalJWKSet } from 'jose';
import { makeVerifier } from './verify.js';
import { jwks, signIdToken, MOCK_ISSUER, MOCK_VC_ISSUER, MOCK_CLIENT_ID } from '../test/mock-issuer.js';

const verify = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  vcIssuer: MOCK_VC_ISSUER,
  jwks: createLocalJWKSet(await jwks()),
});

describe('verifyMinisterIdToken (mock issuer)', () => {
  it('verifies a token and extracts verified badges', async () => {
    const idToken = await signIdToken({
      sub: 'pairwise-abc',
      badges: [{ type: 'email-domain', attributes: { domain: 'acme.com' } }],
    });
    const result = await verify(idToken);
    expect(result.sub).toBe('pairwise-abc');
    expect(result.badges).toEqual([
      expect.objectContaining({ type: 'email-domain', attributes: { domain: 'acme.com' } }),
    ]);
    expect(typeof result.badges[0]!.issuedAt).toBe('number');
  });

  it('rejects a wrong audience', async () => {
    const idToken = await signIdToken({ sub: 's', aud: 'someone-else' });
    await expect(verify(idToken)).rejects.toThrow();
  });

  it('rejects a wrong issuer', async () => {
    const idToken = await signIdToken({ sub: 's', issuer: 'https://evil' });
    await expect(verify(idToken)).rejects.toThrow();
  });

  it('rejects a VC with an unexpected issuer (verifier expects a different vcIssuer)', async () => {
    const v = makeVerifier({
      issuer: MOCK_ISSUER, audience: MOCK_CLIENT_ID, vcIssuer: 'did:web:other',
      jwks: createLocalJWKSet(await jwks()),
    });
    const idToken = await signIdToken({ sub: 's', badges: [{ type: 'email-domain', attributes: { domain: 'a.com' } }] });
    await expect(v(idToken)).rejects.toThrow();
  });

  it('returns an empty badge set when none are disclosed', async () => {
    const idToken = await signIdToken({ sub: 's' });
    expect((await verify(idToken)).badges).toEqual([]);
  });
});
