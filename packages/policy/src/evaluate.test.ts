import { describe, it, expect } from 'vitest';
import { evaluate, evaluateWithProven, isConstrainedLeaf } from './evaluate.js';
import type { PolicyNode, VerifiedBadge } from './types.js';

const NOW = 1_750_000_000; // fixed unix seconds for deterministic expiry tests
const DAY = 86_400;

function badge(
  type: string,
  attributes: VerifiedBadge['attributes'] = {},
  ageDays = 0,
): VerifiedBadge {
  return { type, attributes, issuedAt: NOW - ageDays * DAY };
}

describe('evaluate', () => {
  it('matches a single badge leaf by type', () => {
    const policy: PolicyNode = { badge: { type: 'email-domain' } };
    expect(evaluate(policy, [badge('email-domain')], NOW)).toBe(true);
    expect(evaluate(policy, [badge('oauth-account')], NOW)).toBe(false);
  });

  it('enforces attribute constraints', () => {
    const policy: PolicyNode = { badge: { type: 'email-domain', where: { domain: 'acme.com' } } };
    expect(evaluate(policy, [badge('email-domain', { domain: 'acme.com' })], NOW)).toBe(true);
    expect(evaluate(policy, [badge('email-domain', { domain: 'evil.com' })], NOW)).toBe(false);
  });

  it('enforces maxAgeDays expiry', () => {
    const policy: PolicyNode = { badge: { type: 'age-check', maxAgeDays: 30 } };
    expect(evaluate(policy, [badge('age-check', {}, 10)], NOW)).toBe(true);
    expect(evaluate(policy, [badge('age-check', {}, 31)], NOW)).toBe(false);
  });

  it('allOf requires every child', () => {
    const policy: PolicyNode = {
      allOf: [
        { badge: { type: 'residency-country', where: { country: 'PT' } } },
        { badge: { type: 'email-domain', where: { domain: 'acme.com' } } },
      ],
    };
    expect(
      evaluate(
        policy,
        [
          badge('residency-country', { country: 'PT' }),
          badge('email-domain', { domain: 'acme.com' }),
        ],
        NOW,
      ),
    ).toBe(true);
    expect(evaluate(policy, [badge('residency-country', { country: 'PT' })], NOW)).toBe(false);
  });

  it('anyOf requires at least one child', () => {
    const policy: PolicyNode = { anyOf: [{ badge: { type: 'a' } }, { badge: { type: 'b' } }] };
    expect(evaluate(policy, [badge('b')], NOW)).toBe(true);
    expect(evaluate(policy, [badge('c')], NOW)).toBe(false);
  });

  it('atLeast requires n satisfied children', () => {
    const policy: PolicyNode = {
      atLeast: {
        n: 2,
        of: [{ badge: { type: 'a' } }, { badge: { type: 'b' } }, { badge: { type: 'c' } }],
      },
    };
    expect(evaluate(policy, [badge('a'), badge('b')], NOW)).toBe(true);
    expect(evaluate(policy, [badge('a')], NOW)).toBe(false);
  });

  it('evaluates the personhood + topic example', () => {
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
        { badge: { type: 'steam-game', where: { gameId: 'GAME_X', completed: true } } },
      ],
    };
    const ok = [
      badge('oauth-account', { provider: 'github' }),
      badge('oauth-account', { provider: 'steam' }),
      badge('steam-game', { gameId: 'GAME_X', completed: true }),
    ];
    expect(evaluate(policy, ok, NOW)).toBe(true);

    const missingTopic = [
      badge('oauth-account', { provider: 'github' }),
      badge('oauth-account', { provider: 'steam' }),
    ];
    expect(evaluate(policy, missingTopic, NOW)).toBe(false);
  });

  it('treats a badge issued exactly maxAgeDays ago as still valid (inclusive boundary)', () => {
    const policy: PolicyNode = { badge: { type: 'age-check', maxAgeDays: 30 } };
    expect(evaluate(policy, [badge('age-check', {}, 30)], NOW)).toBe(true);
  });

  it('rejects when a required attribute is absent from the badge', () => {
    const policy: PolicyNode = { badge: { type: 'email-domain', where: { domain: 'acme.com' } } };
    expect(evaluate(policy, [badge('email-domain', {})], NOW)).toBe(false);
  });

  it('uses strict equality: a boolean constraint does not match a string attribute', () => {
    const policy: PolicyNode = { badge: { type: 'steam-game', where: { completed: true } } };
    expect(evaluate(policy, [badge('steam-game', { completed: 'true' })], NOW)).toBe(false);
  });

  it('throws (fails closed) on unrecognized policy shapes', () => {
    // @ts-expect-error malformed shapes are not valid PolicyNode
    expect(() => evaluate({}, [], NOW)).toThrow();
    // @ts-expect-error
    expect(() => evaluate({ foo: 1 }, [], NOW)).toThrow();
    // @ts-expect-error
    expect(() => evaluate([], [], NOW)).toThrow();
  });

  it('documents degenerate-node behavior', () => {
    expect(evaluate({ allOf: [] }, [], NOW)).toBe(true);
    expect(evaluate({ anyOf: [] }, [], NOW)).toBe(false);
    expect(evaluate({ atLeast: { n: 0, of: [] } }, [], NOW)).toBe(true);
    expect(
      evaluate(
        { atLeast: { n: 5, of: [{ badge: { type: 'a' } }, { badge: { type: 'b' } }] } },
        [badge('a'), badge('b')],
        NOW,
      ),
    ).toBe(false);
  });
});

describe('isConstrainedLeaf', () => {
  it('is false for a bare type-only leaf', () => {
    expect(isConstrainedLeaf({ badge: { type: 'a' } })).toBe(false);
  });
  it('is true when the leaf predicates on attributes (where)', () => {
    expect(isConstrainedLeaf({ badge: { type: 'a', where: { x: 1 } } })).toBe(true);
  });
  it('is true when the leaf predicates on freshness (maxAgeDays)', () => {
    expect(isConstrainedLeaf({ badge: { type: 'a', maxAgeDays: 30 } })).toBe(true);
  });
});

describe('evaluateWithProven (token UNION durable, fork F-D)', () => {
  const empty = new Set<string>();

  it('satisfies a bare leaf from the durable proven set when the token lacks it', () => {
    const policy: PolicyNode = { badge: { type: 'age-over-18' } };
    expect(evaluateWithProven(policy, [], new Set(['age-over-18']), NOW)).toBe(true);
  });

  it('satisfies a bare leaf from the live token (durable set empty)', () => {
    const policy: PolicyNode = { badge: { type: 'age-over-18' } };
    expect(evaluateWithProven(policy, [badge('age-over-18')], empty, NOW)).toBe(true);
  });

  it('admits allOf[A,B] when A is in the token and B is durably proven', () => {
    const policy: PolicyNode = {
      allOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    };
    expect(
      evaluateWithProven(policy, [badge('age-over-18')], new Set(['residency-country']), NOW),
    ).toBe(true);
  });

  it('F-D: a `where`-constrained leaf is NOT satisfied from the durable store', () => {
    const policy: PolicyNode = { badge: { type: 'age-over-18', where: { threshold: 21 } } };
    // The type is durably proven, but the store has no attributes -> deny.
    expect(evaluateWithProven(policy, [], new Set(['age-over-18']), NOW)).toBe(false);
    // A live token badge carrying the attribute DOES satisfy it.
    expect(
      evaluateWithProven(policy, [badge('age-over-18', { threshold: 21 })], empty, NOW),
    ).toBe(true);
  });

  it('F-D: a `maxAgeDays`-constrained leaf is NOT satisfied from the durable store', () => {
    const policy: PolicyNode = { badge: { type: 'age-over-18', maxAgeDays: 30 } };
    expect(evaluateWithProven(policy, [], new Set(['age-over-18']), NOW)).toBe(false);
    // A fresh live badge satisfies it; the durable store can never.
    expect(evaluateWithProven(policy, [badge('age-over-18', {}, 10)], empty, NOW)).toBe(true);
  });

  it('denies when a required type is neither in the token nor durably proven', () => {
    const policy: PolicyNode = { badge: { type: 'invite-code' } };
    expect(evaluateWithProven(policy, [badge('age-over-18')], new Set(['age-over-18']), NOW)).toBe(
      false,
    );
  });
});
