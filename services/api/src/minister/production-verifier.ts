import { decodeJwt } from 'jose';
import { getConfig } from '../config.js';
import { logger } from '../log.js';
import { makeVerifier, type VerifiedIdentityWithEpoch } from './verify.js';

type EpochVerifier = (idToken: string) => Promise<VerifiedIdentityWithEpoch>;

let cached: EpochVerifier | undefined;

/**
 * Read the signed `minister_anon_epoch` from an ALREADY-VERIFIED id_token.
 * Called only after the wrapped verifier has confirmed the token's signature,
 * issuer, audience, and expiry, so a plain payload decode is safe (the claim
 * was signed). Same discipline as the SDK's own parse: an integer >= 1, else
 * undefined (omit rather than coerce). Undefined means "no epoch to key on",
 * which the rotate path refuses (C1).
 */
function anonEpochOf(verifiedIdToken: string): number | undefined {
  try {
    const raw = (decodeJwt(verifiedIdToken) as { minister_anon_epoch?: unknown })
      .minister_anon_epoch;
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The verifier bound to the live Minister issuer (built lazily). No `jwks`
 * is injected, so the SDK fetches Minister's JWKS via OIDC discovery and
 * derives the expected badge VC issuer DID from the issuer host.
 *
 * `onRejectedBadges` forwards the shared verifier's SAFE rejected-badge summary
 * (sub, count, reasons - never the raw VC) to Discreetly's pino logger. This is
 * a non-throwing side effect; fail-closed gating is preserved (the verified
 * badges are unchanged). It surfaces misconfiguration (e.g. an issuer-host vs
 * VC-issuer DID mismatch silently rejecting every badge) and forged-badge
 * probing.
 */
export function getProductionVerifier(): EpochVerifier {
  if (!cached) {
    const c = getConfig();
    const base = makeVerifier({
      issuer: c.MINISTER_ISSUER,
      audience: c.MINISTER_CLIENT_ID,
      onRejectedBadges: (report) => {
        logger.warn(
          {
            sub: report.sub,
            rejectedCount: report.rejectedCount,
            rejectedReasons: report.rejectedReasons,
          },
          'discarded unverifiable badge(s) from id_token',
        );
      },
    });
    // Verify (fail-closed via `base`), then attach the signed anon epoch read
    // from the now-verified token, so the gate/rotate path can enforce C1.
    cached = async (idToken) => {
      const identity = await base(idToken);
      return { ...identity, minister_anon_epoch: anonEpochOf(idToken) };
    };
  }
  return cached;
}
