import { describe, expect, it } from 'vitest';
import type { PolicyNode } from '@discreetly/policy';
import {
  computeEligibility,
  decodeBadge,
  decodeBadges,
  scopesToRequestForRoom,
  roomScopeOptions,
  roomHasBranchChoice,
  defaultRoomBranch,
} from './badges';

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

describe('scopesToRequestForRoom (per-room disclosure, model 2b: full required set)', () => {
  it('requests only the base scopes for an open room', () => {
    expect(scopesToRequestForRoom({ allOf: [] })).toEqual(['openid', 'profile']);
  });

  it('requests the badge scope for a single-badge room (nothing proven)', () => {
    const policy: PolicyNode = { badge: { type: 'age-over-18' } };
    expect(scopesToRequestForRoom(policy)).toEqual([
      'openid',
      'profile',
      'badge:age-over-18',
    ]);
  });

  it('2b: requests the room FULL set, NOT the delta: allOf[A,B] with A proven still requests A AND B', () => {
    const policy: PolicyNode = {
      allOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    };
    // Under 2b the already-proven A is re-requested so the live token carries the
    // room's whole set; the delta optimization is intentionally given up.
    expect(scopesToRequestForRoom(policy, ['age-over-18'])).toEqual([
      'openid',
      'profile',
      'badge:age-over-18',
      'badge:residency-country',
    ]);
  });

  it('2b: re-requests the full set even when every required type is already proven', () => {
    const policy: PolicyNode = {
      allOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    };
    expect(scopesToRequestForRoom(policy, ['age-over-18', 'residency-country'])).toEqual([
      'openid',
      'profile',
      'badge:age-over-18',
      'badge:residency-country',
    ]);
  });

  it('OR room: requests exactly one branch (the cheapest), not the union', () => {
    const policy: PolicyNode = {
      anyOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    };
    const scopes = scopesToRequestForRoom(policy);
    // Exactly one badge scope, not both: the OR-branch selection (over-disclosure
    // invariant) is unchanged by 2b - 2b only stops subtracting already-proven
    // types WITHIN the chosen branch.
    const badgeScopesRequested = scopes.filter((s) => s.startsWith('badge:'));
    expect(badgeScopesRequested).toHaveLength(1);
    expect(scopes).toEqual(['openid', 'profile', 'badge:age-over-18']);
  });

  it('OR room: biases to a branch the user already proved, but still requests that FULL branch (2b)', () => {
    const policy: PolicyNode = {
      anyOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    };
    // The user already proved residency-country, so that branch is chosen
    // (least NEW disclosure), and under 2b it is re-requested in full.
    expect(scopesToRequestForRoom(policy, ['residency-country'])).toEqual([
      'openid',
      'profile',
      'badge:residency-country',
    ]);
  });

  it('drops an unknown badge type and fails closed to base scopes when only-unknown', () => {
    const policy: PolicyNode = { badge: { type: 'totally-unknown' } };
    // The unknown branch is unrequestable -> no satisfying known option -> base only.
    expect(scopesToRequestForRoom(policy)).toEqual(['openid', 'profile']);
  });

  it('fails closed to base scopes on a malformed policy', () => {
    expect(scopesToRequestForRoom({} as unknown as PolicyNode)).toEqual(['openid', 'profile']);
  });
});

describe('OR-branch UI helpers (INTERIM)', () => {
  const orPolicy: PolicyNode = {
    anyOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
  };

  it('roomScopeOptions lists each known satisfying branch', () => {
    expect(roomScopeOptions(orPolicy)).toEqual([['age-over-18'], ['residency-country']]);
  });

  it('roomHasBranchChoice is true for an OR room, false for a single-badge room', () => {
    expect(roomHasBranchChoice(orPolicy)).toBe(true);
    expect(roomHasBranchChoice({ badge: { type: 'age-over-18' } })).toBe(false);
  });

  it('defaultRoomBranch picks the cheapest-for-this-user branch', () => {
    expect(defaultRoomBranch(orPolicy)).toEqual(['age-over-18']);
    expect(defaultRoomBranch(orPolicy, ['residency-country'])).toEqual(['residency-country']);
  });
});
