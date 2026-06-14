import { describe, it, expect } from 'vitest';
import { credentialTypeToBadgeType } from './badge-type.js';

describe('credentialTypeToBadgeType', () => {
  it('maps Tessera credential types to policy badge types', () => {
    expect(credentialTypeToBadgeType(['VerifiableCredential', 'TesseraEmailDomainCredential'])).toBe('email-domain');
    expect(credentialTypeToBadgeType(['VerifiableCredential', 'TesseraOauthAccountCredential'])).toBe('oauth-account');
    expect(credentialTypeToBadgeType(['VerifiableCredential', 'TesseraInviteCodeCredential'])).toBe('invite-code');
    expect(credentialTypeToBadgeType(['VerifiableCredential', 'TesseraAgeOver21Credential'])).toBe('age-over-21');
  });
  it('returns null for unrecognized shapes', () => {
    expect(credentialTypeToBadgeType(['VerifiableCredential'])).toBeNull();
    expect(credentialTypeToBadgeType(['VerifiableCredential', 'SomethingElse'])).toBeNull();
  });
});
