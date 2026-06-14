import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { VerifiedBadge } from '@discreetly/policy';
import { config } from '../config.js';
import { credentialTypeToBadgeType } from './badge-type.js';

export interface VerifiedIdentity {
  sub: string;
  badges: VerifiedBadge[];
}

interface VerifierDeps {
  issuer: string;
  audience: string;
  vcIssuer: string;
  jwks: JWTVerifyGetKey;
}

interface VcBody {
  type?: string[];
  credentialSubject?: Record<string, unknown>;
}

/** Factory so tests can inject a local JWKS + mock issuer config. */
export function makeVerifier(deps: VerifierDeps) {
  return async function verifyMinisterIdToken(idToken: string): Promise<VerifiedIdentity> {
    const { payload } = await jwtVerify(idToken, deps.jwks, {
      issuer: deps.issuer,
      audience: deps.audience,
      requiredClaims: ['exp', 'iat'],
      maxTokenAge: '10m',
    });
    const sub = payload.sub;
    if (!sub) throw new Error('id_token missing sub');

    const raw = Array.isArray(payload.tessera_badges) ? payload.tessera_badges : [];
    const badges: VerifiedBadge[] = [];
    for (const vcJwt of raw) {
      if (typeof vcJwt !== 'string') throw new Error('non-string badge entry');
      const { payload: vc } = await jwtVerify(vcJwt, deps.jwks, { requiredClaims: ['exp', 'iat'] });
      if (vc.iss !== deps.vcIssuer) throw new Error(`unexpected VC issuer: ${String(vc.iss)}`);
      const body = vc.vc as VcBody | undefined;
      if (!body?.type || !body.credentialSubject) throw new Error('malformed VC');
      const type = credentialTypeToBadgeType(body.type);
      if (!type) throw new Error(`unrecognized VC type: ${JSON.stringify(body.type)}`);
      const { id: _id, ...attributes } = body.credentialSubject;
      badges.push({
        type,
        attributes: attributes as VerifiedBadge['attributes'],
        issuedAt: typeof vc.iat === 'number' ? vc.iat : 0,
      });
    }
    return { sub, badges };
  };
}

/** Production verifier bound to the configured live Minister JWKS. */
export const verifyMinisterIdToken = makeVerifier({
  issuer: config.MINISTER_ISSUER,
  audience: config.MINISTER_CLIENT_ID,
  vcIssuer: config.MINISTER_VC_ISSUER,
  jwks: createRemoteJWKSet(new URL(config.MINISTER_JWKS_URL)),
});
