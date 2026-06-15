import { describe, expect, it } from 'vitest';
import type { PolicyNode } from '@discreetly/policy';
import { policyNodeSchema, OPEN_POLICY } from '@discreetly/policy';
import {
  type PolicyBuilderNode,
  type CompositeBuilderNode,
  type AtLeastBuilderNode,
  type BadgeBuilderNode,
  makeAllOf,
  makeAnyOf,
  makeAtLeast,
  makeBadge,
  makeOpenPolicy,
  openPolicyNode,
  serializeNode,
  deserializeNode,
  buildAndValidate,
} from './policy-builder';

// ---- Helpers -----------------------------------------------------------------

function roundTrip(node: PolicyNode): PolicyBuilderNode {
  return deserializeNode(node);
}

function serializeRoundTrip(node: PolicyNode): PolicyNode {
  return serializeNode(roundTrip(node));
}

// ---- allOf round-trip --------------------------------------------------------

describe('allOf round-trip', () => {
  it('serializes an allOf node back to allOf', () => {
    const policy: PolicyNode = {
      allOf: [
        { badge: { type: 'email-domain' } },
        { badge: { type: 'invite-code' } },
      ],
    };
    const result = serializeRoundTrip(policy);
    expect(result).toEqual(policy);
  });

  it('roundtrips an empty allOf (open policy)', () => {
    const policy: PolicyNode = { allOf: [] };
    const builder = deserializeNode(policy) as CompositeBuilderNode;
    expect(builder.kind).toBe('allOf');
    expect(builder.children).toHaveLength(0);
    expect(serializeNode(builder)).toEqual({ allOf: [] });
  });

  it('validates via policyNodeSchema after serialization', () => {
    const policy: PolicyNode = {
      allOf: [{ badge: { type: 'email-domain' } }],
    };
    const r = buildAndValidate(deserializeNode(policy));
    expect(r.ok).toBe(true);
  });
});

// ---- anyOf round-trip --------------------------------------------------------

describe('anyOf round-trip', () => {
  it('serializes an anyOf node back to anyOf', () => {
    const policy: PolicyNode = {
      anyOf: [
        { badge: { type: 'email-domain' } },
        { badge: { type: 'oauth-account' } },
      ],
    };
    expect(serializeRoundTrip(policy)).toEqual(policy);
  });

  it('validates via policyNodeSchema', () => {
    const policy: PolicyNode = {
      anyOf: [{ badge: { type: 'age-over-18' } }],
    };
    const r = buildAndValidate(deserializeNode(policy));
    expect(r.ok).toBe(true);
  });
});

// ---- atLeast round-trip ------------------------------------------------------

describe('atLeast round-trip', () => {
  it('serializes an atLeast node preserving n and children', () => {
    const policy: PolicyNode = {
      atLeast: {
        n: 2,
        of: [
          { badge: { type: 'email-domain' } },
          { badge: { type: 'invite-code' } },
          { badge: { type: 'age-over-18' } },
        ],
      },
    };
    expect(serializeRoundTrip(policy)).toEqual(policy);
  });

  it('round-trips n=0 (admit-none atLeast)', () => {
    const policy: PolicyNode = { atLeast: { n: 0, of: [] } };
    const builder = deserializeNode(policy) as AtLeastBuilderNode;
    expect(builder.kind).toBe('atLeast');
    expect(builder.n).toBe('0');
    expect(serializeNode(builder)).toEqual(policy);
  });

  it('validates via policyNodeSchema', () => {
    const policy: PolicyNode = {
      atLeast: { n: 1, of: [{ badge: { type: 'email-domain' } }] },
    };
    const r = buildAndValidate(deserializeNode(policy));
    expect(r.ok).toBe(true);
  });
});

// ---- badge leaf (with where + maxAgeDays) ------------------------------------

describe('badge leaf round-trip', () => {
  it('round-trips a badge with where constraints', () => {
    const policy: PolicyNode = {
      badge: {
        type: 'residency-country',
        where: { country: 'US' },
      },
    };
    expect(serializeRoundTrip(policy)).toEqual(policy);
  });

  it('round-trips a badge with maxAgeDays', () => {
    const policy: PolicyNode = {
      badge: { type: 'email-domain', maxAgeDays: 30 },
    };
    expect(serializeRoundTrip(policy)).toEqual(policy);
  });

  it('round-trips a badge with both where and maxAgeDays', () => {
    const policy: PolicyNode = {
      badge: {
        type: 'residency-country',
        where: { country: 'CA' },
        maxAgeDays: 90,
      },
    };
    const builder = deserializeNode(policy) as BadgeBuilderNode;
    expect(builder.kind).toBe('badge');
    expect(builder.badgeType).toBe('residency-country');
    expect(builder.maxAgeDays).toBe('90');
    expect(builder.where).toEqual([{ key: 'country', value: 'CA' }]);
    expect(serializeNode(builder)).toEqual(policy);
  });

  it('omits where when all entries have blank keys', () => {
    const builder: BadgeBuilderNode = {
      id: 'test',
      kind: 'badge',
      badgeType: 'email-domain',
      where: [{ key: '', value: 'ignored' }],
      maxAgeDays: '',
    };
    const serialized = serializeNode(builder);
    expect('where' in (serialized as { badge: object }).badge).toBe(false);
  });

  it('omits maxAgeDays when left blank', () => {
    const builder: BadgeBuilderNode = {
      id: 'test',
      kind: 'badge',
      badgeType: 'email-domain',
      where: [],
      maxAgeDays: '',
    };
    const serialized = serializeNode(builder) as { badge: { maxAgeDays?: number } };
    expect(serialized.badge.maxAgeDays).toBeUndefined();
  });
});

// ---- OPEN_POLICY shortcut ----------------------------------------------------

describe('OPEN_POLICY shortcut', () => {
  it('makeOpenPolicy produces a builder allOf with no children', () => {
    const node = makeOpenPolicy();
    expect(node.kind).toBe('allOf');
    expect(node.children).toHaveLength(0);
  });

  it('openPolicyNode() matches OPEN_POLICY after serialization', () => {
    const node = openPolicyNode();
    expect(serializeNode(node)).toEqual(OPEN_POLICY);
  });

  it('buildAndValidate on open policy returns ok=true', () => {
    const r = buildAndValidate(makeOpenPolicy());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy).toEqual({ allOf: [] });
    }
  });
});

// ---- Invalid builder states caught by policyNodeSchema -----------------------

describe('invalid builder states', () => {
  it('buildAndValidate returns ok=false for an atLeast node with non-integer n', () => {
    const atLeast = makeAtLeast();
    // Force an invalid n string
    (atLeast as AtLeastBuilderNode & { n: string }).n = 'abc';
    const r = buildAndValidate(atLeast);
    // Number('abc') = NaN; policyNodeSchema expects int
    expect(r.ok).toBe(false);
  });

  it('policyNodeSchema rejects a negative n for atLeast', () => {
    const result = policyNodeSchema.safeParse({
      atLeast: { n: -1, of: [] },
    });
    expect(result.success).toBe(false);
  });

  it('policyNodeSchema rejects an empty badge type', () => {
    const result = policyNodeSchema.safeParse({ badge: { type: '' } });
    expect(result.success).toBe(false);
  });

  it('policyNodeSchema rejects unknown keys (strict mode)', () => {
    const result = policyNodeSchema.safeParse({
      badge: { type: 'email-domain', unknownField: true },
    });
    expect(result.success).toBe(false);
  });

  it('buildAndValidate returns ok=false for an empty badge type', () => {
    const builder = makeBadge();
    (builder as BadgeBuilderNode & { badgeType: string }).badgeType = '';
    const r = buildAndValidate(builder);
    expect(r.ok).toBe(false);
  });
});

// ---- Factory helpers produce valid nodes -------------------------------------

describe('factory helpers', () => {
  it('makeAllOf produces a valid allOf builder node', () => {
    const n = makeAllOf();
    expect(n.kind).toBe('allOf');
    const r = buildAndValidate(n);
    expect(r.ok).toBe(true);
  });

  it('makeAnyOf produces a valid anyOf builder node', () => {
    const n = makeAnyOf();
    expect(n.kind).toBe('anyOf');
    const r = buildAndValidate(n);
    expect(r.ok).toBe(true);
  });

  it('makeAtLeast with one child produces a valid atLeast node', () => {
    const n = makeAtLeast();
    n.children.push(makeBadge());
    const r = buildAndValidate(n);
    expect(r.ok).toBe(true);
  });

  it('makeBadge produces a valid badge node', () => {
    const n = makeBadge();
    const r = buildAndValidate(n);
    expect(r.ok).toBe(true);
  });

  it('each factory call produces a unique id', () => {
    const ids = new Set([
      makeAllOf().id,
      makeAnyOf().id,
      makeAtLeast().id,
      makeBadge().id,
    ]);
    expect(ids.size).toBe(4);
  });
});

// ---- Nested composite round-trips -------------------------------------------

describe('nested composite round-trips', () => {
  it('allOf containing anyOf and badge leaf', () => {
    const policy: PolicyNode = {
      allOf: [
        {
          anyOf: [
            { badge: { type: 'email-domain' } },
            { badge: { type: 'invite-code' } },
          ],
        },
        { badge: { type: 'age-over-18' } },
      ],
    };
    expect(serializeRoundTrip(policy)).toEqual(policy);
  });

  it('atLeast nesting inside anyOf', () => {
    const policy: PolicyNode = {
      anyOf: [
        {
          atLeast: {
            n: 1,
            of: [
              { badge: { type: 'email-domain' } },
              { badge: { type: 'residency-country', where: { country: 'US' } } },
            ],
          },
        },
        { badge: { type: 'invite-code' } },
      ],
    };
    expect(serializeRoundTrip(policy)).toEqual(policy);
  });
});
