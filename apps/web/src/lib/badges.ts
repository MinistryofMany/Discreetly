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
} from '@discreetly/policy';
import { badgeTypeOf, badgeScopes, knownBadgeTypes } from '@ministryofmany/client/badges';

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

// ---- Per-room disclosure request (Phase 2: Minister selects) -------------------
//
// Phase 2: Discreetly no longer picks an OR/threshold branch. It requests the
// UNION of every badge type the room's policy mentions as the authorize `scope`
// (the *menu* of types the RP may ask about) and sends the room's policy AST as
// the `minister_policy` param (see `minister-policy.ts`). Minister - which knows
// each type's anonymity-set size - selects the minimal satisfying set to disclose
// and lets the user override at consent. The Phase-1 interim OR-branch picker
// (`roomScopeOptions`/`defaultRoomBranch`/branch-selection UI) is retired.
//
// For an `allOf`-only room the union IS the unambiguous required set, so behavior
// is unchanged from Phase 1. For an OR/threshold room the union now lists every
// candidate type in `scope`; the `minister_policy` structure tells Minister which
// minimal subset to actually disclose, so the relying party still receives only
// one satisfying set (the over-disclosure invariant is upheld by Minister's
// server-side selection, not by Discreetly pre-picking).

/** The always-requested base scopes; a join that needs no badge asks only this. */
export const BASE_SCOPES: readonly string[] = ['openid', 'profile'];

/** The Minister badge slugs Discreetly knows how to request, as a set. */
const KNOWN_TYPES: ReadonlySet<string> = new Set(knownBadgeTypes());

/**
 * The scopes to request at a room join: `openid profile` plus a `badge:<type>`
 * for every type the room's policy mentions (the UNION), restricted to badge
 * slugs Discreetly knows how to request. This is the menu of types the RP is
 * allowed to ask about; the accompanying `minister_policy` param (encoded
 * separately) carries the structure over that menu so Minister selects the
 * minimal satisfying subset to disclose.
 *
 * Fail-closed: a malformed policy (or one mentioning only unknown slugs) yields
 * just the base scopes; the server gate is authoritative and denies an
 * insufficient disclosure. The over-disclosure-to-relying-party invariant is
 * preserved by Minister's selection: even though the union scope lists every
 * candidate type, Minister discloses only one satisfying subset.
 */
export function scopesToRequestForRoom(policy: PolicyNode): string[] {
  let types: string[];
  try {
    // `requiredScopes` returns `badge:<type>` for the union of mentioned types,
    // sorted; strip the prefix and keep only known, requestable slugs.
    types = requiredScopes(policy)
      .map((scope) => scope.replace(/^badge:/, ''))
      .filter((type) => KNOWN_TYPES.has(type));
  } catch {
    types = [];
  }
  if (types.length === 0) return [...BASE_SCOPES];
  return [...BASE_SCOPES, ...badgeScopes(types)];
}
