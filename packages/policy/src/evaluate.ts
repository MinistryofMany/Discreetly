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
  // Exhaustiveness: a new PolicyNode variant will fail to compile here.
  const _exhaustive: never = policy;
  return _exhaustive;
}
