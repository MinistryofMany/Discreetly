import { decodeJwt } from 'jose';

export interface MinisterDisplayClaims {
  sub: string | null;
  name: string | null;
  picture: string | null;
  ministerBadges: string[];
}

const EMPTY: MinisterDisplayClaims = {
  sub: null,
  name: null,
  picture: null,
  ministerBadges: [],
};

/**
 * Decode (NOT verify) a Minister id_token payload for display. The API is the
 * sole verification authority; this only recovers the values the UI renders
 * (signed-in user) and the raw badge VC JWTs the client-side preview decoder
 * reads. On any decode failure - malformed token, wrong segment count, bad
 * base64url - this returns safe empties rather than throwing, so a bad token
 * degrades the display without breaking the session.
 */
/**
 * Decode (NOT verify) the `exp` claim of an id_token, in epoch seconds.
 * Returns null when the token is absent, malformed, or has no numeric exp.
 * Used only to short-circuit UI states (e.g. "admin session expired") before
 * asking the API; the API's verification remains authoritative.
 */
export function idTokenExpiresAt(idToken: string | null): number | null {
  if (!idToken) return null;
  try {
    const { exp } = decodeJwt(idToken);
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

export function decodeMinisterClaims(idToken: string | null): MinisterDisplayClaims {
  if (!idToken) return EMPTY;
  try {
    const p = decodeJwt(idToken) as {
      sub?: unknown;
      name?: unknown;
      picture?: unknown;
      minister_badges?: unknown;
    };
    return {
      sub: typeof p.sub === 'string' ? p.sub : null,
      name: typeof p.name === 'string' ? p.name : null,
      picture: typeof p.picture === 'string' ? p.picture : null,
      ministerBadges: Array.isArray(p.minister_badges)
        ? p.minister_badges.filter((x): x is string => typeof x === 'string')
        : [],
    };
  } catch {
    return EMPTY;
  }
}
