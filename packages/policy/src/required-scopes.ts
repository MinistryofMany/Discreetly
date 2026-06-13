import { type PolicyNode, isBadgeLeaf, isAllOf, isAnyOf, isAtLeast } from './types.js';

/** Distinct `badge:<type>` OIDC scopes a room policy requires, sorted. */
export function requiredScopes(policy: PolicyNode): string[] {
  const types = new Set<string>();

  const walk = (node: PolicyNode): void => {
    if (isBadgeLeaf(node)) {
      types.add(node.badge.type);
      return;
    }
    if (isAllOf(node)) {
      node.allOf.forEach(walk);
      return;
    }
    if (isAnyOf(node)) {
      node.anyOf.forEach(walk);
      return;
    }
    if (isAtLeast(node)) {
      node.atLeast.of.forEach(walk);
      return;
    }
  };

  walk(policy);
  return [...types].sort().map((type) => `badge:${type}`);
}
