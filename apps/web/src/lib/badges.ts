/**
 * Client-side decoding of Minister badge VC JWTs into the policy `VerifiedBadge`
 * shape, used ONLY to render a "you can join" hint in the UI. The signature is
 * NOT verified here - the API re-verifies every VC on `membership.join` and is
 * the sole authority. This is a convenience preview, never a gate.
 */
import {
  type PolicyNode,
  type VerifiedBadge,
  evaluate,
  requiredScopes,
  minimalScopeOptions,
  chooseScopeOption,
  requiredTypesForRoom,
} from '@discreetly/policy';
import { badgeTypeOf, badgeScopes, knownBadgeTypes } from '@minister/client/badges';

/**
 * Map a VC `type` array to the Minister badge slug using the SDK's canonical
 * vocabulary, or null if it is not a known Minister credential. This is the
 * same slug mapping the API verifier uses, sourced from one place.
 */
function credentialTypeToBadgeType(vcTypes: readonly string[]): string | null {
  return badgeTypeOf([...vcTypes]) ?? null;
}

function base64UrlDecode(segment: string): string {
  let s = segment.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  const binary = atob(s);
  let out = '';
  for (let i = 0; i < binary.length; i++) {
    out += String.fromCharCode(binary.charCodeAt(i));
  }
  // Decode UTF-8 bytes -> string.
  try {
    return decodeURIComponent(
      Array.from(out)
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
  } catch {
    return out;
  }
}

interface VcPayload {
  iat?: unknown;
  nbf?: unknown;
  vc?: {
    type?: unknown;
    credentialSubject?: Record<string, unknown>;
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Decode a single VC JWT (no signature check) into a `VerifiedBadge`, or null
 * if it cannot be parsed / is not a recognized Minister credential.
 */
export function decodeBadge(jwt: string): VerifiedBadge | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  let payload: VcPayload;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]!)) as VcPayload;
  } catch {
    return null;
  }
  const vc = payload.vc;
  if (!isPlainObject(vc)) return null;
  const types = vc.type;
  if (!Array.isArray(types) || !types.every((t) => typeof t === 'string')) return null;
  const type = credentialTypeToBadgeType(types as string[]);
  if (type === null) return null;

  const attributes: Record<string, string | number | boolean> = {};
  const subject = vc.credentialSubject;
  if (isPlainObject(subject)) {
    for (const [k, v] of Object.entries(subject)) {
      if (k === 'id') continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        attributes[k] = v;
      }
    }
  }

  const issuedAt =
    typeof payload.iat === 'number'
      ? payload.iat
      : typeof payload.nbf === 'number'
        ? payload.nbf
        : Math.floor(Date.now() / 1000);

  return { type, attributes, issuedAt };
}

/** Decode all disclosed badge JWTs from the session (drops unparseable ones). */
export function decodeBadges(jwts: readonly string[]): VerifiedBadge[] {
  return jwts.map(decodeBadge).filter((b): b is VerifiedBadge => b !== null);
}

export interface JoinEligibility {
  /** Distinct `badge:<type>` scopes the room policy requires. */
  requiredScopes: string[];
  /** Decoded badges the session currently discloses. */
  disclosed: VerifiedBadge[];
  /**
   * Whether the disclosed badges satisfy the policy (client-side preview; the
   * server re-verifies and is authoritative).
   */
  satisfied: boolean;
}

/**
 * Compute whether the session's disclosed badges satisfy a room policy. `now` is
 * unix seconds (injected for deterministic tests).
 */
export function computeEligibility(
  policy: PolicyNode,
  badgeJwts: readonly string[],
  now: number = Math.floor(Date.now() / 1000),
): JoinEligibility {
  const disclosed = decodeBadges(badgeJwts);
  let satisfied: boolean;
  try {
    satisfied = evaluate(policy, disclosed, now);
  } catch {
    // Malformed policy -> fail closed in the hint (server is authoritative anyway).
    satisfied = false;
  }
  return { requiredScopes: requiredScopes(policy), disclosed, satisfied };
}

// ---- Per-room minimal disclosure (request side) -------------------------------

/** The always-requested base scopes; a join that needs no new badge asks only this. */
export const BASE_SCOPES: readonly string[] = ['openid', 'profile'];

/** The Minister badge slugs Discreetly knows how to request, as a set. */
const KNOWN_TYPES: ReadonlySet<string> = new Set(knownBadgeTypes());

/**
 * The satisfying badge-type sets a room admits, restricted to known slugs - the
 * INTERIM OR/threshold picker's options. Empty when unsatisfiable or malformed
 * (the caller then requests only the base scopes and the server denies). INTERIM
 * - Phase 2 moves OR-selection to Minister.
 */
export function roomScopeOptions(policy: PolicyNode): string[][] {
  return minimalScopeOptions(policy, { knownTypes: KNOWN_TYPES });
}

/**
 * Model 2b: the scopes to request at join - `openid profile` plus the badge
 * scopes for the room's FULL chosen branch (NOT minus already-proven types). The
 * owner chose to re-request a room's whole required set on each join so the live
 * token presented to the gate carries that room's complete badge set,
 * independent of any prior sign-in's token. Fails closed to `BASE_SCOPES` on a
 * malformed/unsatisfiable policy (the server gate is authoritative and denies).
 *
 * The over-disclosure-to-relying-party invariant holds: the requested badges are
 * exactly ONE satisfying branch of THIS room's policy (OR/threshold rooms still
 * pick a single branch), so Discreetly only ever receives badges the room it
 * joins requires - never the whole wallet, never another room's badges.
 *
 * `provenTypes` is used ONLY to bias the OR-branch choice toward one the user has
 * already mostly proven (least NEW disclosure to Minister within the choice); it
 * does NOT subtract from the requested set.
 *
 * INTERIM - the OR/threshold branch is auto-picked (cheapest for this user);
 * Phase 2 moves that selection to Minister.
 */
export function scopesToRequestForRoom(
  policy: PolicyNode,
  provenTypes: readonly string[] = [],
): string[] {
  let required: string[] | null;
  try {
    required = requiredTypesForRoom(policy, new Set(provenTypes), {
      knownTypes: KNOWN_TYPES,
    });
  } catch {
    required = null;
  }
  // null => unsatisfiable/malformed; empty => the room needs no badges. Either
  // way, request only the base scopes (the gate decides admission).
  if (required === null || required.length === 0) return [...BASE_SCOPES];
  return [...BASE_SCOPES, ...badgeScopes(required)];
}

/**
 * Whether a room policy offers a genuine OR/threshold choice (more than one
 * satisfying branch), so the UI should surface the INTERIM "choose a different
 * proof" affordance.
 */
export function roomHasBranchChoice(policy: PolicyNode): boolean {
  return roomScopeOptions(policy).length > 1;
}

/** The default (cheapest-for-this-user) branch the join will request. INTERIM. */
export function defaultRoomBranch(
  policy: PolicyNode,
  provenTypes: readonly string[] = [],
): string[] | null {
  try {
    return chooseScopeOption(policy, new Set(provenTypes), { knownTypes: KNOWN_TYPES });
  } catch {
    return null;
  }
}
