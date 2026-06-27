import {
  type PolicyNode,
  type VerifiedBadge,
  type BadgeLeaf,
  isBadgeLeaf,
  isAllOf,
  isAnyOf,
  isAtLeast,
} from './types.js';

const SECONDS_PER_DAY = 86_400;

function leafSatisfied(leaf: BadgeLeaf, badges: VerifiedBadge[], now: number): boolean {
  const { type, where, maxAgeDays } = leaf.badge;
  return badges.some((candidate) => {
    if (candidate.type !== type) return false;
    if (maxAgeDays !== undefined && now - candidate.issuedAt > maxAgeDays * SECONDS_PER_DAY) {
      return false;
    }
    if (where) {
      for (const [key, value] of Object.entries(where)) {
        if (candidate.attributes[key] !== value) return false;
      }
    }
    return true;
  });
}

/**
 * Evaluate a room access policy against the set of verified, disclosed badges.
 * `now` is unix seconds, passed in for deterministic testing.
 */
export function evaluate(policy: PolicyNode, badges: VerifiedBadge[], now: number): boolean {
  if (isBadgeLeaf(policy)) return leafSatisfied(policy, badges, now);
  if (isAllOf(policy)) return policy.allOf.every((node) => evaluate(node, badges, now));
  if (isAnyOf(policy)) return policy.anyOf.some((node) => evaluate(node, badges, now));
  if (isAtLeast(policy)) {
    const satisfied = policy.atLeast.of.filter((node) => evaluate(node, badges, now)).length;
    return satisfied >= policy.atLeast.n;
  }
  // Exhaustiveness (compile-time) + fail-closed (runtime): a new PolicyNode variant
  // fails to compile here; a malformed/unrecognized runtime shape throws so callers
  // can never mistake a non-boolean for an admit.
  const _exhaustive: never = policy;
  throw new Error(`unknown policy node shape: ${JSON.stringify(_exhaustive)}`);
}

/** A policy leaf is "constrained" iff it predicates on attributes or freshness. */
export function isConstrainedLeaf(leaf: BadgeLeaf): boolean {
  return leaf.badge.where !== undefined || leaf.badge.maxAgeDays !== undefined;
}

/**
 * Evaluate a policy against the union of (live verified token badges) and (the
 * user's durable proven badge TYPES), enforcing fork F-D:
 *
 *   A CONSTRAINED leaf (`where`/`maxAgeDays`) may ONLY be satisfied by a live
 *   token badge - never from the durable proven set, which carries no attribute
 *   values and no issued-at. A bare type-only leaf may be satisfied by a token
 *   badge OR a durably-proven type.
 *
 * This is the load-bearing security invariant for the durable store: it can only
 * ever short-circuit disclosure for type-only leaves, so `maxAgeDays`/`where`
 * stay enforceable against a live VC. `tokenBadges` are the verified badges from
 * the presented id_token; `provenTypes` is the durable set for the same verified
 * `sub`. `now` is unix seconds.
 */
export function evaluateWithProven(
  policy: PolicyNode,
  tokenBadges: VerifiedBadge[],
  provenTypes: ReadonlySet<string>,
  now: number,
): boolean {
  if (isBadgeLeaf(policy)) {
    if (leafSatisfied(policy, tokenBadges, now)) return true;
    // Only bare type-only leaves may be satisfied from the durable store.
    if (isConstrainedLeaf(policy)) return false;
    return provenTypes.has(policy.badge.type);
  }
  if (isAllOf(policy))
    return policy.allOf.every((node) => evaluateWithProven(node, tokenBadges, provenTypes, now));
  if (isAnyOf(policy))
    return policy.anyOf.some((node) => evaluateWithProven(node, tokenBadges, provenTypes, now));
  if (isAtLeast(policy)) {
    const satisfied = policy.atLeast.of.filter((node) =>
      evaluateWithProven(node, tokenBadges, provenTypes, now),
    ).length;
    return satisfied >= policy.atLeast.n;
  }
  const _exhaustive: never = policy;
  throw new Error(`unknown policy node shape: ${JSON.stringify(_exhaustive)}`);
}
