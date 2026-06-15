/**
 * UI state types and serialization for the policy builder.
 *
 * The builder works with a tree of `PolicyBuilderNode` values (plain objects,
 * uniquely identified so React can manage list keys). `serializePolicy`
 * converts the builder tree to a `PolicyNode` ready for `policyNodeSchema`
 * validation and API submission.
 */

import type { PolicyNode } from '@discreetly/policy';
import { policyNodeSchema, OPEN_POLICY } from '@discreetly/policy';

// ---- UI node types ---------------------------------------------------------

export type BuilderNodeKind = 'allOf' | 'anyOf' | 'atLeast' | 'badge';

export interface WhereEntry {
  key: string;
  value: string;
}

export interface BadgeBuilderNode {
  id: string;
  kind: 'badge';
  badgeType: string;
  where: WhereEntry[];
  maxAgeDays: string; // string for controlled input; '' = unset
}

export interface CompositeBuilderNode {
  id: string;
  kind: 'allOf' | 'anyOf';
  children: PolicyBuilderNode[];
}

export interface AtLeastBuilderNode {
  id: string;
  kind: 'atLeast';
  n: string; // string for controlled input
  children: PolicyBuilderNode[];
}

export type PolicyBuilderNode =
  | BadgeBuilderNode
  | CompositeBuilderNode
  | AtLeastBuilderNode;

// ---- Known badge types -------------------------------------------------------

export const KNOWN_BADGE_TYPES = [
  'email-domain',
  'email-exact',
  'oauth-account',
  'residency-country',
  'residency-state',
  'residency-city',
  'invite-code',
  'age-over-18',
  'age-over-21',
  'age-over-25',
  'tlsn-attestation',
] as const;

// ---- Factory helpers --------------------------------------------------------

let _idSeq = 0;
function nextId(): string {
  return `node-${++_idSeq}`;
}

export function makeAllOf(): CompositeBuilderNode {
  return { id: nextId(), kind: 'allOf', children: [] };
}

export function makeAnyOf(): CompositeBuilderNode {
  return { id: nextId(), kind: 'anyOf', children: [] };
}

export function makeAtLeast(): AtLeastBuilderNode {
  return { id: nextId(), kind: 'atLeast', n: '1', children: [] };
}

export function makeBadge(): BadgeBuilderNode {
  return {
    id: nextId(),
    kind: 'badge',
    badgeType: 'email-domain',
    where: [],
    maxAgeDays: '',
  };
}

/** The empty "open" policy as a builder node */
export function makeOpenPolicy(): CompositeBuilderNode {
  return { id: nextId(), kind: 'allOf', children: [] };
}

// ---- Serialization ----------------------------------------------------------

/**
 * Convert a builder node to a PolicyNode.
 * May throw if n is not a valid integer for atLeast nodes, but the UI
 * validates before calling this.
 */
export function serializeNode(node: PolicyBuilderNode): PolicyNode {
  if (node.kind === 'badge') {
    const where: Record<string, string> = {};
    for (const entry of node.where) {
      if (entry.key.trim()) {
        where[entry.key.trim()] = entry.value;
      }
    }
    return {
      badge: {
        type: node.badgeType,
        ...(Object.keys(where).length > 0 && { where }),
        ...(node.maxAgeDays !== '' && { maxAgeDays: Number(node.maxAgeDays) }),
      },
    };
  }

  if (node.kind === 'allOf') {
    return { allOf: node.children.map(serializeNode) };
  }

  if (node.kind === 'anyOf') {
    return { anyOf: node.children.map(serializeNode) };
  }

  // atLeast
  const atLeast = node as AtLeastBuilderNode;
  return {
    atLeast: {
      n: Number(atLeast.n),
      of: atLeast.children.map(serializeNode),
    },
  };
}

/**
 * Serialize and validate a builder tree.
 * Returns `{ ok: true, policy }` or `{ ok: false, error }`.
 */
export function buildAndValidate(
  root: PolicyBuilderNode,
): { ok: true; policy: PolicyNode } | { ok: false; error: string } {
  let serialized: PolicyNode;
  try {
    serialized = serializeNode(root);
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const result = policyNodeSchema.safeParse(serialized);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
  }

  return { ok: true, policy: result.data };
}

// ---- Deserialization (PolicyNode -> builder tree) ---------------------------

/**
 * Parse a PolicyNode back into a builder tree (e.g. for editing an existing room).
 */
export function deserializeNode(node: PolicyNode): PolicyBuilderNode {
  if ('badge' in node) {
    const where: WhereEntry[] = node.badge.where
      ? Object.entries(node.badge.where).map(([key, value]) => ({
          key,
          value: String(value),
        }))
      : [];
    return {
      id: nextId(),
      kind: 'badge',
      badgeType: node.badge.type,
      where,
      maxAgeDays: node.badge.maxAgeDays !== undefined ? String(node.badge.maxAgeDays) : '',
    };
  }

  if ('allOf' in node) {
    return {
      id: nextId(),
      kind: 'allOf',
      children: node.allOf.map(deserializeNode),
    };
  }

  if ('anyOf' in node) {
    return {
      id: nextId(),
      kind: 'anyOf',
      children: node.anyOf.map(deserializeNode),
    };
  }

  // atLeast
  return {
    id: nextId(),
    kind: 'atLeast',
    n: String(node.atLeast.n),
    children: node.atLeast.of.map(deserializeNode),
  };
}

/** Convert OPEN_POLICY to a builder node */
export function openPolicyNode(): CompositeBuilderNode {
  return deserializeNode(OPEN_POLICY) as CompositeBuilderNode;
}
