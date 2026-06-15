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

const MINISTER_CRED = /^Minister(.+)Credential$/;

/** Map a VC `type` array to the policy badge-type string (mirrors backend). */
function credentialTypeToBadgeType(vcTypes: readonly string[]): string | null {
  const specific = vcTypes.find((t) => t !== 'VerifiableCredential');
  if (!specific) return null;
  const m = MINISTER_CRED.exec(specific);
  if (!m) return null;
  const g = m[1];
  if (!g) return null;
  return g
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])([0-9])/g, '$1-$2')
    .toLowerCase();
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
