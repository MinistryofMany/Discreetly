import { describe, it, expect } from 'vitest';
import { getProductionVerifier } from './production-verifier.js';
import { getRealMinisterIdToken } from '../test/minister-live.js';

const idToken = await getRealMinisterIdToken();

describe.skipIf(!idToken)('verifyMinisterIdToken (LIVE Minister)', () => {
  it('verifies a real id_token + email-domain VC against the live JWKS', async () => {
    const result = await getProductionVerifier()(idToken!);
    expect(result.sub).toBeTruthy();
    const emailBadge = result.badges.find((b) => b.type === 'email-domain');
    expect(emailBadge).toBeTruthy();
    expect(typeof emailBadge!.attributes.domain).toBe('string');
  });
});
