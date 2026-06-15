import { getConfig } from '../config.js';
import { makeVerifier } from './verify.js';

let cached: ReturnType<typeof makeVerifier> | undefined;

/**
 * The verifier bound to the live Minister issuer (built lazily). No `jwks`
 * is injected, so the SDK fetches Minister's JWKS via OIDC discovery and
 * derives the expected badge VC issuer DID from the issuer host.
 */
export function getProductionVerifier(): ReturnType<typeof makeVerifier> {
  if (!cached) {
    const c = getConfig();
    cached = makeVerifier({
      issuer: c.MINISTER_ISSUER,
      audience: c.MINISTER_CLIENT_ID,
    });
  }
  return cached;
}
