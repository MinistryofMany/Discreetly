import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

const KID = 'did:web:mock.minister#key-1';
export const MOCK_VC_ISSUER = 'did:web:mock.minister';
export const MOCK_ISSUER = 'https://mock.minister';
export const MOCK_CLIENT_ID = 'discreetly_test';

const { publicKey, privateKey } = await generateKeyPair('EdDSA');

export async function jwks(): Promise<{ keys: JWK[] }> {
  const jwk = await exportJWK(publicKey);
  return { keys: [{ ...jwk, alg: 'EdDSA', use: 'sig', kid: KID }] };
}

export interface MockBadge {
  type: string;
  attributes: Record<string, string | number | boolean>;
  ageDays?: number;
  expired?: boolean;
}

function badgeTypeToCredType(type: string): string {
  const pascal = type
    .split('-')
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('');
  return `Minister${pascal}Credential`;
}

async function signVc(userId: string, badge: MockBadge): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const iatSec = badge.expired ? nowSec - 120 : nowSec - (badge.ageDays ?? 0) * 86_400;
  const builder = new SignJWT({
    vc: {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', badgeTypeToCredType(badge.type)],
      credentialSubject: { id: `${MOCK_VC_ISSUER}:users:${userId}`, ...badge.attributes },
    },
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: KID, typ: 'vc+jwt' })
    .setIssuer(MOCK_VC_ISSUER)
    .setSubject(`${MOCK_VC_ISSUER}:users:${userId}`)
    .setIssuedAt(iatSec)
    .setExpirationTime(badge.expired ? nowSec - 60 : '365d');
  return builder.sign(privateKey);
}

export async function signIdToken(opts: {
  sub: string;
  userId?: string;
  badges?: MockBadge[];
  aud?: string;
  issuer?: string;
  nonce?: string;
}): Promise<string> {
  const userId = opts.userId ?? 'mockuser';
  const minister_badges = await Promise.all((opts.badges ?? []).map((b) => signVc(userId, b)));
  return new SignJWT({ nonce: opts.nonce ?? 'n', minister_badges })
    .setProtectedHeader({ alg: 'EdDSA', kid: KID, typ: 'JWT' })
    .setIssuer(opts.issuer ?? MOCK_ISSUER)
    .setSubject(opts.sub)
    .setAudience(opts.aud ?? MOCK_CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}
