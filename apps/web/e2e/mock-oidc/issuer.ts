/**
 * Mock OIDC issuer for Discreetly e2e. Self-hosted, deterministic, and faithful
 * to the live Minister contract (EdDSA id_tokens carrying `minister_badges` VC
 * JWTs, pairwise `sub`, PKCE S256). It NEVER touches the real Minister.
 *
 * Auth.js v5 (the web RP) discovers endpoints from
 * `/.well-known/openid-configuration`; the Discreetly API verifier is pointed at
 * the same issuer + JWKS so it accepts the same tokens. The signing/VC shape
 * mirrors `services/api/src/test/mock-issuer.ts` exactly so the API verifier
 * (`makeVerifier`) accepts these tokens unchanged.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

const KID = 'did:web:mock.minister#key-1';
export const MOCK_VC_ISSUER = 'did:web:mock.minister';
export const MOCK_CLIENT_ID = 'discreetly_dev';

const { publicKey, privateKey } = await generateKeyPair('EdDSA');

let publicJwk: JWK | undefined;
async function jwks(): Promise<{ keys: JWK[] }> {
  publicJwk ??= await exportJWK(publicKey);
  return { keys: [{ ...publicJwk, alg: 'EdDSA', use: 'sig', kid: KID }] };
}

export interface MockBadge {
  type: string;
  attributes: Record<string, string | number | boolean>;
  /** Age of the VC in days (used to exercise `maxAgeDays` policy predicates). */
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
  return new SignJWT({
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
    .setExpirationTime(badge.expired ? nowSec - 60 : '365d')
    .sign(privateKey);
}

/** Deterministic pairwise sub from an email so tests can pre-seed AdminUser. */
export function subFor(email: string): string {
  return `mock|${email}`;
}

export interface MintOpts {
  issuer: string;
  sub: string;
  name?: string;
  badges?: MockBadge[];
  nonce?: string;
  userId?: string;
}

/** Mint an id_token directly (for non-browser checks). */
export async function mintIdToken(opts: MintOpts): Promise<string> {
  const userId = opts.userId ?? opts.sub.replace(/[^a-zA-Z0-9]/g, '');
  const minister_badges = await Promise.all((opts.badges ?? []).map((b) => signVc(userId, b)));
  const builder = new SignJWT({
    nonce: opts.nonce,
    ...(opts.name !== undefined && { name: opts.name }),
    minister_badges,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: KID, typ: 'JWT' })
    .setIssuer(opts.issuer)
    .setSubject(opts.sub)
    .setAudience(MOCK_CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('10m');
  return builder.sign(privateKey);
}

// ---- Authorization-code store --------------------------------------------------

interface PendingAuth {
  state: string;
  nonce?: string;
  codeChallenge: string;
  redirectUri: string;
}

interface IssuedCode {
  sub: string;
  name?: string;
  badges: MockBadge[];
  nonce?: string;
  codeChallenge: string;
  redirectUri: string;
}

const pending = new Map<string, PendingAuth>(); // state -> pending auth
const codes = new Map<string, IssuedCode>(); // code -> grant

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Mock Minister</title></head><body>${body}</body></html>`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * The badge profiles selectable on the consent screen. A test can drive the HTML
 * form, or use the fast-path query params (`sub`, `email`, `badges`, `auto=1`).
 */
const BADGE_CATALOG: Record<string, MockBadge> = {
  'email-domain': { type: 'email-domain', attributes: { domain: 'example.com' } },
  'invite-code': { type: 'invite-code', attributes: { code: 'WELCOME' } },
  'oauth-account': { type: 'oauth-account', attributes: { provider: 'github' } },
  'residency-country': { type: 'residency-country', attributes: { country: 'US' } },
  'age-over-18': { type: 'age-over-18', attributes: { over: true } },
};

export interface MockIssuerHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startMockIssuer(port: number): Promise<MockIssuerHandle> {
  const issuer = `http://localhost:${port}`;

  const server = createServer((req, res) => {
    void handle(req, res, issuer).catch((err) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`mock issuer error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  return {
    url: issuer,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, issuer: string): Promise<void> {
  const url = new URL(req.url ?? '/', issuer);
  const path = url.pathname;

  if (path === '/.well-known/openid-configuration') {
    return json(res, {
      issuer,
      authorization_endpoint: `${issuer}/oidc/authorize`,
      token_endpoint: `${issuer}/oidc/token`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      userinfo_endpoint: `${issuer}/oidc/userinfo`,
      response_types_supported: ['code'],
      subject_types_supported: ['pairwise'],
      id_token_signing_alg_values_supported: ['EdDSA'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      grant_types_supported: ['authorization_code'],
      scopes_supported: [
        'openid',
        'profile',
        'badge:email-domain',
        'badge:invite-code',
        'badge:oauth-account',
        'badge:residency-country',
        'badge:age-over-18',
      ],
      claims_supported: ['sub', 'iss', 'aud', 'iat', 'exp', 'nonce', 'name', 'minister_badges'],
      code_challenge_methods_supported: ['S256'],
    });
  }

  if (path === '/.well-known/jwks.json') {
    return json(res, await jwks());
  }

  if (path === '/oidc/authorize') return authorize(req, res, url);
  if (path === '/oidc/approve') return approve(req, res);
  if (path === '/oidc/token') return token(req, res, issuer);

  if (path === '/oidc/userinfo') {
    // Minimal userinfo; the app reads claims from the id_token, not here.
    return json(res, { sub: 'mock' });
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorize(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const q = url.searchParams;
  const responseType = q.get('response_type');
  const redirectUri = q.get('redirect_uri');
  const state = q.get('state');
  const codeChallenge = q.get('code_challenge');
  const codeChallengeMethod = q.get('code_challenge_method');
  const nonce = q.get('nonce') ?? undefined;

  if (responseType !== 'code' || !redirectUri || !state || !codeChallenge) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(
      'invalid authorize request (need response_type=code, redirect_uri, state, code_challenge)',
    );
    return;
  }
  if (codeChallengeMethod !== 'S256') {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('PKCE S256 required');
    return;
  }

  pending.set(state, { state, nonce, codeChallenge, redirectUri });

  // Fast-path: tests preselect sub/email + badges and auto-submit.
  const auto = q.get('auto');
  if (auto === '1') {
    const email = q.get('email') ?? 'user@example.com';
    const sub = q.get('sub') ?? subFor(email);
    const name = q.get('name') ?? email;
    const badgeKeys = (q.get('badges') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const badges = badgeKeys
      .map((k) => BADGE_CATALOG[k])
      .filter((b): b is MockBadge => b !== undefined);
    return finishLogin(res, state, { sub, name, badges });
  }

  // Render the deterministic login + consent page.
  const checkboxes = Object.keys(BADGE_CATALOG)
    .map((k) => `<label><input type="checkbox" name="badge" value="${k}" /> ${k}</label><br/>`)
    .join('');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    html(`
      <h1>Mock Minister sign in</h1>
      <form method="POST" action="/oidc/approve">
        <input type="hidden" name="state" value="${state}" />
        <label>Email <input id="email" name="email" value="user@example.com" /></label><br/>
        <label>Name <input id="name" name="name" value="Test User" /></label><br/>
        <fieldset><legend>Disclose badges</legend>${checkboxes}</fieldset>
        <button id="approve" type="submit">Approve</button>
      </form>
    `),
  );
}

// Approve handler is registered through the same dispatch (POST /oidc/approve).
// Hook it into handle() by intercepting before 404. We extend handle via a check
// here: the dispatcher routes POST /oidc/approve to this function.
async function approve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const state = form.get('state');
  if (!state || !pending.has(state)) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('unknown state');
    return;
  }
  const email = form.get('email') ?? 'user@example.com';
  const name = form.get('name') ?? email;
  const sub = subFor(email);
  const badgeKeys = form.getAll('badge');
  const badges = badgeKeys
    .map((k) => BADGE_CATALOG[k])
    .filter((b): b is MockBadge => b !== undefined);
  finishLogin(res, state, { sub, name, badges });
}

function finishLogin(
  res: ServerResponse,
  state: string,
  user: { sub: string; name?: string; badges: MockBadge[] },
): void {
  const p = pending.get(state)!;
  pending.delete(state);
  const code = randomBytes(24).toString('base64url');
  codes.set(code, {
    sub: user.sub,
    name: user.name,
    badges: user.badges,
    nonce: p.nonce,
    codeChallenge: p.codeChallenge,
    redirectUri: p.redirectUri,
  });
  const location = new URL(p.redirectUri);
  location.searchParams.set('code', code);
  location.searchParams.set('state', state);
  res.writeHead(302, { location: location.toString() });
  res.end();
}

// `authorize` renders a POST form to /oidc/approve; the dispatcher in `handle`
// routes it to `approve` above.

async function token(req: IncomingMessage, res: ServerResponse, issuer: string): Promise<void> {
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const grantType = form.get('grant_type');
  const code = form.get('code');
  const codeVerifier = form.get('code_verifier');

  if (grantType !== 'authorization_code' || !code || !codeVerifier) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_request' }));
    return;
  }

  const grant = codes.get(code);
  if (!grant) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'unknown code' }));
    return;
  }
  codes.delete(code); // one-time use

  if (s256(codeVerifier) !== grant.codeChallenge) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE mismatch' }));
    return;
  }

  const idToken = await mintIdToken({
    issuer,
    sub: grant.sub,
    name: grant.name,
    badges: grant.badges,
    nonce: grant.nonce,
  });

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      access_token: randomBytes(16).toString('base64url'),
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: 600,
    }),
  );
}
