import { getConfig } from '../config.js';
import { logger } from '../log.js';
import { makeVerifier } from './verify.js';

let cached: ReturnType<typeof makeVerifier> | undefined;

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
export function getProductionVerifier(): ReturnType<typeof makeVerifier> {
  if (!cached) {
    const c = getConfig();
    cached = makeVerifier({
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
  }
  return cached;
}
