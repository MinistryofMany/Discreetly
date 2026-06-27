import { describe, it, expect } from 'vitest';
import {
  requiredScopes,
  minimalScopeOptions,
  chooseScopeOption,
  requiredTypesForChosenBranch,
} from './required-scopes.js';
import type { PolicyNode } from './types.js';

describe('requiredScopes', () => {
  it('returns a single scope for a single badge leaf', () => {
    const policy: PolicyNode = { badge: { type: 'email-domain', where: { domain: 'acme.com' } } };
    expect(requiredScopes(policy)).toEqual(['badge:email-domain']);
  });

  it('collects and dedupes badge types across a nested tree, sorted', () => {
    const policy: PolicyNode = {
      allOf: [
        {
          atLeast: {
            n: 2,
            of: [
              { badge: { type: 'oauth-account', where: { provider: 'github' } } },
              { badge: { type: 'oauth-account', where: { provider: 'google' } } },
              { badge: { type: 'oauth-account', where: { provider: 'steam' } } },
            ],
          },
        },
        { badge: { type: 'steam-game', where: { gameId: 'GAME_X' } } },
      ],
    };
    expect(requiredScopes(policy)).toEqual(['badge:oauth-account', 'badge:steam-game']);
  });

  it('handles anyOf', () => {
    const policy: PolicyNode = {
      anyOf: [{ badge: { type: 'residency-country' } }, { badge: { type: 'email-domain' } }],
    };
    expect(requiredScopes(policy)).toEqual(['badge:email-domain', 'badge:residency-country']);
  });
});

describe('minimalScopeOptions (INTERIM)', () => {
  it('allOf[A,B] -> one option {A,B} (conjunction)', () => {
    const policy: PolicyNode = {
      allOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    };
    expect(minimalScopeOptions(policy)).toEqual([['age-over-18', 'residency-country']]);
  });

  it('anyOf[A,B] -> two single-type options', () => {
    const policy: PolicyNode = {
      anyOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    };
    expect(minimalScopeOptions(policy)).toEqual([['age-over-18'], ['residency-country']]);
  });

  it('atLeast{n:2,of:[A,B,C]} -> all size-2 options', () => {
    const policy: PolicyNode = {
      atLeast: {
        n: 2,
        of: [
          { badge: { type: 'age-over-18' } },
          { badge: { type: 'residency-country' } },
          { badge: { type: 'email-domain' } },
        ],
      },
    };
    expect(minimalScopeOptions(policy)).toEqual([
      ['age-over-18', 'email-domain'],
      ['age-over-18', 'residency-country'],
      ['email-domain', 'residency-country'],
    ]);
  });

  it('open policy (allOf: []) -> a single empty option (no badges)', () => {
    expect(minimalScopeOptions({ allOf: [] })).toEqual([[]]);
  });

  it('drops an option that needs an unknown badge type (known-slug guard)', () => {
    const known = new Set(['age-over-18']);
    const policy: PolicyNode = {
      anyOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'totally-unknown' } }],
    };
    // The unknown branch is unrequestable; only the known branch survives.
    expect(minimalScopeOptions(policy, { knownTypes: known })).toEqual([['age-over-18']]);
  });

  it('fails closed to [] on a malformed policy', () => {
    expect(minimalScopeOptions({} as unknown as PolicyNode)).toEqual([]);
  });
});

describe('chooseScopeOption / delta (INTERIM)', () => {
  const orPolicy: PolicyNode = {
    anyOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
  };

  it('default-picks the cheapest branch when nothing is proven (lexicographic tie-break)', () => {
    expect(chooseScopeOption(orPolicy)).toEqual(['age-over-18']);
  });

  it('prefers the branch the user has already proven (fewest new types)', () => {
    const proven = new Set(['residency-country']);
    expect(chooseScopeOption(orPolicy, proven)).toEqual(['residency-country']);
  });

  it('delta subtracts the already-proven types from the chosen branch', () => {
    const policy: PolicyNode = {
      allOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    };
    const proven = new Set(['age-over-18']);
    expect(requiredTypesForChosenBranch(policy, proven)).toEqual(['residency-country']);
  });

  it('delta is empty when every required type is already proven', () => {
    const policy: PolicyNode = { badge: { type: 'age-over-18' } };
    expect(requiredTypesForChosenBranch(policy, new Set(['age-over-18']))).toEqual([]);
  });

  it('returns null for an unsatisfiable policy (anyOf: [])', () => {
    expect(chooseScopeOption({ anyOf: [] })).toBeNull();
    expect(requiredTypesForChosenBranch({ anyOf: [] })).toBeNull();
  });
});
