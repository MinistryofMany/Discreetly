import { describe, expect, it } from 'vitest';
import type { PolicyNode } from '@discreetly/policy';
import { computeEligibility, decodeBadge, decodeBadges } from './badges';

function b64url(obj: unknown): string {
  const json = JSON.stringify(obj);
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build an unsigned (signature segment ignored) VC JWT for tests. */
function vcJwt(
  credentialType: string,
  subject: Record<string, unknown> = {},
  iat = Math.floor(Date.now() / 1000),
): string {
  const header = b64url({ typ: 'vc+jwt', alg: 'EdDSA' });
  const payload = b64url({
    iss: 'did:web:minister.local',
    iat,
    vc: {
      type: ['VerifiableCredential', credentialType],
      credentialSubject: { id: 'did:web:minister.local:users:1', ...subject },
    },
  });
  return `${header}.${payload}.signature`;
}

describe('decodeBadge', () => {
  it('maps a Minister credential type to the kebab badge type', () => {
    const badge = decodeBadge(vcJwt('MinisterEmailDomainCredential', { domain: 'acme.com' }));
    expect(badge).not.toBeNull();
    expect(badge!.type).toBe('email-domain');
    expect(badge!.attributes.domain).toBe('acme.com');
  });

  it('maps numeric-suffixed credential types (age-over-21)', () => {
    const badge = decodeBadge(vcJwt('MinisterAgeOver21Credential', { threshold: 21 }));
    expect(badge!.type).toBe('age-over-21');
  });

  it('drops the credentialSubject id from attributes', () => {
    const badge = decodeBadge(vcJwt('MinisterInviteCodeCredential', { label: 'x' }));
    expect(badge!.attributes).not.toHaveProperty('id');
    expect(badge!.attributes.label).toBe('x');
  });

  it('returns null for a non-Minister credential', () => {
    expect(decodeBadge(vcJwt('SomeOtherCredential'))).toBeNull();
  });

  it('returns null for a malformed jwt', () => {
    expect(decodeBadge('not-a-jwt')).toBeNull();
    expect(decodeBadge('only.one')).not.toBeUndefined();
    expect(decodeBadge('garbage.@@@.sig')).toBeNull();
  });
});

describe('decodeBadges', () => {
  it('decodes valid badges and drops invalid ones', () => {
    const list = decodeBadges([
      vcJwt('MinisterEmailDomainCredential'),
      'garbage',
      vcJwt('MinisterInviteCodeCredential'),
    ]);
    expect(list.map((b) => b.type)).toEqual(['email-domain', 'invite-code']);
  });
});

describe('computeEligibility', () => {
  const NOW = 1_700_000_000;

  it('an open policy (allOf:[]) requires no scopes and is satisfied', () => {
    const policy: PolicyNode = { allOf: [] };
    const e = computeEligibility(policy, [], NOW);
    expect(e.requiredScopes).toEqual([]);
    expect(e.satisfied).toBe(true);
  });

  it('lists required scopes and is unsatisfied without the badge', () => {
    const policy: PolicyNode = { badge: { type: 'email-domain' } };
    const e = computeEligibility(policy, [], NOW);
    expect(e.requiredScopes).toEqual(['badge:email-domain']);
    expect(e.satisfied).toBe(false);
  });

  it('is satisfied when the disclosed badge matches', () => {
    const policy: PolicyNode = { badge: { type: 'email-domain' } };
    const e = computeEligibility(
      policy,
      [vcJwt('MinisterEmailDomainCredential', {}, NOW - 10)],
      NOW,
    );
    expect(e.satisfied).toBe(true);
  });

  it('honors attribute constraints (where)', () => {
    const policy: PolicyNode = {
      badge: { type: 'residency-country', where: { country: 'US' } },
    };
    const wrong = computeEligibility(
      policy,
      [vcJwt('MinisterResidencyCountryCredential', { country: 'CA' }, NOW - 10)],
      NOW,
    );
    expect(wrong.satisfied).toBe(false);
    const right = computeEligibility(
      policy,
      [vcJwt('MinisterResidencyCountryCredential', { country: 'US' }, NOW - 10)],
      NOW,
    );
    expect(right.satisfied).toBe(true);
  });

  it('honors maxAgeDays (stale badge fails)', () => {
    const policy: PolicyNode = { badge: { type: 'email-domain', maxAgeDays: 1 } };
    const stale = NOW - 3 * 86_400;
    const e = computeEligibility(
      policy,
      [vcJwt('MinisterEmailDomainCredential', {}, stale)],
      NOW,
    );
    expect(e.satisfied).toBe(false);
  });

  it('evaluates anyOf / allOf composites', () => {
    const policy: PolicyNode = {
      anyOf: [{ badge: { type: 'email-domain' } }, { badge: { type: 'invite-code' } }],
    };
    const e = computeEligibility(
      policy,
      [vcJwt('MinisterInviteCodeCredential', {}, NOW - 10)],
      NOW,
    );
    expect(e.requiredScopes).toEqual(['badge:email-domain', 'badge:invite-code']);
    expect(e.satisfied).toBe(true);
  });
});
