import { createHash, randomBytes } from 'node:crypto';

// Opt-in: the DB-mediated grant reaches into Minister's dev DB, whose role/name
// move with the provider (a past provider rename changed it). Set
// MINISTER_DEV_DATABASE_URL to enable; unset => the live test skips. (The
// authoritative live proof is Plan 4's browser e2e against the settled provider.)
const DEV_DB = process.env.MINISTER_DEV_DATABASE_URL;
const REDIRECT = 'http://localhost:3001/api/auth/callback/minister';
const b64url = (b: Buffer) => b.toString('base64url');

/**
 * Obtain a REAL Minister id_token for the seeded dev user + their email-domain
 * badge by inserting a consent row directly and exchanging it at the live
 * /oidc/token. Returns null if not configured or the provider/DB is unreachable.
 */
export async function getRealMinisterIdToken(): Promise<string | null> {
  if (!DEV_DB) return null;
  let pg: typeof import('pg');
  try {
    pg = await import('pg');
  } catch {
    return null;
  }
  const client = new pg.default.Client({ connectionString: DEV_DB });
  try {
    await client.connect();
  } catch {
    return null;
  }
  try {
    const user = (await client.query('select id from "User" limit 1')).rows[0];
    const badge = (await client.query(`select id from "Badge" where type='email-domain' limit 1`))
      .rows[0];
    if (!user || !badge) return null;

    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const code = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(16));
    await client.query(
      `insert into "OidcAuthorizationCode"
       (code,"clientId","userId","redirectUri",scopes,"approvedBadgeIds",nonce,"codeChallenge","codeChallengeMethod","expiresAt")
       values ($1,'discreetly_dev',$2,$3,$4,$5,$6,$7,'S256', now() + interval '60 seconds')`,
      [
        code,
        user.id,
        REDIRECT,
        ['openid', 'profile', 'badge:email-domain'],
        [badge.id],
        nonce,
        challenge,
      ],
    );

    const res = await fetch('http://localhost:3000/oidc/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: 'discreetly_dev',
        client_secret: process.env.MINISTER_CLIENT_SECRET ?? 'discreetly_dev_secret_2026',
        code_verifier: verifier,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { id_token?: string };
    return json.id_token ?? null;
  } finally {
    await client.end();
  }
}
