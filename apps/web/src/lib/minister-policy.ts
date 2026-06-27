/**
 * Encode a room's access policy AST into the `minister_policy` authorize param.
 *
 * Phase 2: for a room whose policy accepts a CHOICE of badges (`anyOf`/`atLeast`),
 * Minister - not Discreetly - selects which badge(s) to disclose, because only
 * Minister knows each badge type's anonymity-set size. Discreetly sends Minister
 * the room's policy requirement (the criteria), not a pre-picked branch, as a
 * base64url(JSON) custom authorize parameter carried on the THIRD `signIn` arg.
 *
 * This is the front-channel transport (design fork F-6): the param travels on the
 * browser-visible authorize URL, but it carries only the room's PUBLIC access
 * policy (already shown to the user as "Required badges" chips) - no user data.
 * The SELECTION (which of the user's badges) happens entirely inside Minister.
 *
 * Encoding is fail-closed: if the policy cannot be serialized, the encoder
 * returns `null` and the caller OMITS the param. Minister then treats each
 * requested `badge:` scope independently (today's behavior) and the server gate
 * at Discreetly remains the sole admission authority, so omission never
 * over-discloses - it only forgoes the anonymity-set-aware pre-selection.
 */
import type { PolicyNode } from '@discreetly/policy';

/** base64url-encode a UTF-8 string (no padding), browser + Node safe. */
function base64UrlEncode(input: string): string {
  // Encode the string as UTF-8 bytes, then base64, then make it URL-safe.
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url-decode to a UTF-8 string. Throws on malformed input. */
function base64UrlDecode(segment: string): string {
  let s = segment.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Encode a room policy AST into the `minister_policy` authorize-param value, or
 * `null` if it cannot be serialized (fail-closed -> the caller omits the param).
 */
export function encodeMinisterPolicy(policy: PolicyNode): string | null {
  try {
    return base64UrlEncode(JSON.stringify(policy));
  } catch {
    return null;
  }
}

/**
 * Decode a `minister_policy` param value back into the policy AST, or `null` on
 * malformed input. Used by tests (and the e2e mock issuer) to verify the
 * round-trip; Discreetly itself never decodes its own outbound param.
 */
export function decodeMinisterPolicy(param: string): PolicyNode | null {
  try {
    return JSON.parse(base64UrlDecode(param)) as PolicyNode;
  } catch {
    return null;
  }
}
