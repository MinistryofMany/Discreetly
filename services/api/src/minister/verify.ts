import {
  createMinisterVerifier,
  type KeyInput,
  type VerifiedBadge as VerifiedBadgeSdk,
} from '@minister/client';
import type { VerifiedBadge } from '@discreetly/policy';

export interface VerifiedIdentity {
  sub: string;
  badges: VerifiedBadge[];
}

export interface VerifierDeps {
  issuer: string;
  /** Mapped to the SDK's `clientId` so the id_token `aud` is enforced. */
  audience: string;
  /**
   * Inject a verification key to keep tests offline (e.g. a
   * `createLocalJWKSet(...)` resolver). Omit in production: the SDK then
   * fetches Minister's JWKS via the issuer (OIDC discovery + did:web). The
   * SDK derives the expected badge VC issuer DID from `issuer`, so there is
   * no separate `vcIssuer`.
   */
  jwks?: KeyInput;
}

/**
 * Recover the VC `iat` (seconds) from an already-verified VC JWT. The SDK's
 * `VerifiedBadge` drops `iat`, but the policy engine needs `issuedAt`. No
 * signature work happens here: the SDK already verified `raw`, so we only
 * base64url-decode the payload segment and read `iat`. Returns 0 when the
 * claim is absent or the payload is unparseable.
 */
function iatFromRawVc(rawVcJwt: string): number {
  const seg = rawVcJwt.split('.')[1];
  if (!seg) return 0;
  try {
    const json = Buffer.from(seg, 'base64url').toString('utf8');
    const iat = (JSON.parse(json) as { iat?: unknown }).iat;
    return typeof iat === 'number' ? iat : 0;
  } catch {
    return 0;
  }
}

/**
 * Factory so tests can inject a local JWKS + mock issuer config. Wraps the
 * `@minister/client` verifier and reproduces the `VerifiedIdentity` contract
 * the rest of the API consumes.
 *
 * Bad-badge handling: the SDK never throws on an individual malformed,
 * expired, wrong-issuer, or unknown-type badge - it drops it into `rejected`
 * and returns the verified ones in `badges`. We surface only the verified
 * `badges`, so a forged or expired badge simply does not count toward a
 * policy (fails closed). The id_token wrapper itself still throws on a bad
 * signature / issuer / audience / expiry.
 */
export function makeVerifier(deps: VerifierDeps) {
  const verifier = createMinisterVerifier({
    issuer: deps.issuer,
    clientId: deps.audience,
    jwks: deps.jwks,
  });
  return async function verifyMinisterIdToken(idToken: string): Promise<VerifiedIdentity> {
    // Throws MinisterTokenError on a bad id_token signature / iss / aud / exp / iat.
    const claims = await verifier.verifyIdToken(idToken);
    // Passing the raw id_token re-verifies the wrapper (issuer/audience/key)
    // before reading its badges; individual bad badges land in `rejected`.
    const { badges } = await verifier.verifyBadges(idToken);
    return {
      sub: claims.sub,
      badges: badges.map((b: VerifiedBadgeSdk) => ({
        type: b.type,
        attributes: b.claims as VerifiedBadge['attributes'],
        issuedAt: iatFromRawVc(b.raw),
      })),
    };
  };
}
