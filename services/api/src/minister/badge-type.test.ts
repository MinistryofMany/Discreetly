import { describe, it, expect } from 'vitest';
import { credentialTypeToBadgeType } from './badge-type.js';

describe('credentialTypeToBadgeType', () => {
  it('maps Minister credential types to policy badge types', () => {
    expect(
      credentialTypeToBadgeType(['VerifiableCredential', 'MinisterEmailDomainCredential']),
    ).toBe('email-domain');
    expect(
      credentialTypeToBadgeType(['VerifiableCredential', 'MinisterOauthAccountCredential']),
    ).toBe('oauth-account');
    expect(credentialTypeToBadgeType(['VerifiableCredential', 'MinisterInviteCodeCredential'])).toBe(
      'invite-code',
    );
    expect(credentialTypeToBadgeType(['VerifiableCredential', 'MinisterAgeOver21Credential'])).toBe(
      'age-over-21',
    );
  });
  it('returns null for unrecognized shapes', () => {
    expect(credentialTypeToBadgeType(['VerifiableCredential'])).toBeNull();
    expect(credentialTypeToBadgeType(['VerifiableCredential', 'SomethingElse'])).toBeNull();
  });
});
