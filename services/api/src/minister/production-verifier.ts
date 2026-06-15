import { createRemoteJWKSet } from 'jose';
import { getConfig } from '../config.js';
import { makeVerifier } from './verify.js';

let cached: ReturnType<typeof makeVerifier> | undefined;

/** The verifier bound to the configured live Minister JWKS (built lazily). */
export function getProductionVerifier(): ReturnType<typeof makeVerifier> {
  if (!cached) {
    const c = getConfig();
    cached = makeVerifier({
      issuer: c.MINISTER_ISSUER,
      audience: c.MINISTER_CLIENT_ID,
      vcIssuer: c.MINISTER_VC_ISSUER,
      jwks: createRemoteJWKSet(new URL(c.MINISTER_JWKS_URL)),
    });
  }
  return cached;
}
