import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { VerifiedBadge } from '@discreetly/policy';
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
      // Pin the signature algorithm so a token cannot downgrade to an
      // unexpected alg (e.g. "none" or a symmetric alg) against the JWKS.
      algorithms: ['EdDSA'],
      issuer: deps.issuer,
      audience: deps.audience,
      requiredClaims: ['exp', 'iat'],
      maxTokenAge: '10m',
    });
    const sub = payload.sub;
    if (!sub) throw new Error('id_token missing sub');

    const raw = Array.isArray(payload.minister_badges) ? payload.minister_badges : [];
    const badges: VerifiedBadge[] = [];
    for (const vcJwt of raw) {
      if (typeof vcJwt !== 'string') throw new Error('non-string badge entry');
      const { payload: vc } = await jwtVerify(vcJwt, deps.jwks, {
        algorithms: ['EdDSA'],
        issuer: deps.vcIssuer,
        requiredClaims: ['exp', 'iat'],
      });
      // jose already enforces the issuer above; this redundant check keeps a
      // precise error message and guards if the option is ever changed.
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
