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
import { type PolicyNode, isBadgeLeaf, isAllOf, isAnyOf, isAtLeast } from '@discreetly/policy';

export const MOCK_CLIENT_ID = 'discreetly_dev';

/**
 * The `minister_anon_epoch` the browser flow stamps on every id_token and the
 * epoch the delivered anon-identity branch is keyed at. Live Minister signs this
 * integer (>= 1) into the id_token; the RP's client-side handoff
 * (`minister-anon.ts`) treats it as the SOLE authority on adopt/re-key. A re-key
 * (a NEW branch at a strictly greater epoch) is exercised via `mintIdToken({
 * epoch })` and the API's epoch-gated `membership.rotate`, not this browser flow.
 */
const DEFAULT_ANON_EPOCH = 1;

/**
 * The 32-byte per-app anon-identity branch Minister derives for this RP and
 * delivers on the OIDC redirect fragment. Deterministic per (sub, epoch) so a
 * test can reproduce the exact identity the app derives, and so the SAME user
 * always derives the SAME identity (the one-root invariant) while a bumped epoch
 * yields a DIFFERENT branch (a re-key). Mirrors live Minister's per-app-secret
 * contract: 32 bytes, delivered base64url as `#minister_anon=v1.<43 chars>`.
 */
export function branchForSub(sub: string, epoch: number): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`minister-anon|${sub}|${epoch}`).digest());
}

/** The `minister_anon=v1.<43 base64url>` fragment param for (sub, epoch). */
function anonFragmentParam(sub: string, epoch: number): string {
  return `minister_anon=v1.${Buffer.from(branchForSub(sub, epoch)).toString('base64url')}`;
}

/**
 * Derive the badge VC issuer DID from the runtime OIDC issuer port. The SDK
 * verifier (`@ministryofmany/client`) expects the badge `iss` to equal
 * `didFromIssuer(issuer)` === `did:web:localhost%3A<port>` (the colon in the
 * host:port is percent-encoded per the did:web spec); there is no override.
 * Signing VCs with this DID is what makes badges verify under the SDK.
 */
function vcIssuerForPort(port: number): string {
  return `did:web:localhost%3A${port}`;
}
function kidForPort(port: number): string {
  return `${vcIssuerForPort(port)}#key-1`;
}

const { publicKey, privateKey } = await generateKeyPair('EdDSA');

let publicJwk: JWK | undefined;
async function jwks(port: number): Promise<{ keys: JWK[] }> {
  publicJwk ??= await exportJWK(publicKey);
  return { keys: [{ ...publicJwk, alg: 'EdDSA', use: 'sig', kid: kidForPort(port) }] };
}

/**
 * did:web DID document at `/.well-known/did.json`. The SDK verifier pins badge
 * VC keys to the DID document's `assertionMethod` — NOT the raw JWKS — so
 * Minister's token key can never attest a badge (the KMS split). A badge whose
 * `kid` is absent from `assertionMethod` is rejected outright, which means this
 * endpoint is REQUIRED: without it every badge lands in `rejected` (fails
 * closed) and every gated join is denied. Mirrors the live Minister document:
 * the badge signing key is the sole `assertionMethod` entry.
 */
async function didDocument(port: number): Promise<Record<string, unknown>> {
  publicJwk ??= await exportJWK(publicKey);
  const did = vcIssuerForPort(port);
  const kid = kidForPort(port);
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    id: did,
    verificationMethod: [
      { id: kid, type: 'JsonWebKey2020', controller: did, publicKeyJwk: publicJwk },
    ],
    assertionMethod: [kid],
    authentication: [kid],
  };
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

async function signVc(sub: string, badge: MockBadge, port: number): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const iatSec = badge.expired ? nowSec - 120 : nowSec - (badge.ageDays ?? 0) * 86_400;
  const vcIssuer = vcIssuerForPort(port);
  // Minister re-mints every DISCLOSED badge under the holder's per-RP pairwise
  // pseudonym: subject `did:web:<host>:u:<id_token sub>`. (The stored badge's
  // stable `:users:<userId>` DID never leaves Minister.) The SDK's holder
  // binding requires subject === buildPairwiseSubjectDid(issuer, id_token.sub),
  // so the mock must stamp exactly this shape or every badge lands in
  // `rejected`.
  const subjectId = `${vcIssuer}:u:${sub}`;
  return new SignJWT({
    vc: {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', badgeTypeToCredType(badge.type)],
      credentialSubject: { id: subjectId, ...badge.attributes },
    },
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: kidForPort(port), typ: 'vc+jwt' })
    .setIssuer(vcIssuer)
    .setSubject(subjectId)
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
  /**
   * The `minister_anon_epoch` claim to sign onto the token (integer >= 1). Omit
   * to sign no epoch claim. The browser flow always passes `DEFAULT_ANON_EPOCH`;
   * the re-key test mints a strictly-greater epoch to authorize a leaf swap.
   */
  epoch?: number;
}

/** Mint an id_token directly (for non-browser checks). */
export async function mintIdToken(opts: MintOpts): Promise<string> {
  const port = Number(new URL(opts.issuer).port);
  const minister_badges = await Promise.all(
    (opts.badges ?? []).map((b) => signVc(opts.sub, b, port)),
  );
  const builder = new SignJWT({
    nonce: opts.nonce,
    ...(opts.name !== undefined && { name: opts.name }),
    ...(opts.epoch !== undefined && { minister_anon_epoch: opts.epoch }),
    minister_badges,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: kidForPort(port), typ: 'JWT' })
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
  /** The raw `scope` the RP requested at /oidc/authorize (space-delimited). */
  scope: string;
  /** The decoded `minister_policy` requirement, if the RP sent one (Phase 2). */
  ministerPolicy?: PolicyNode | null;
  /** Test override: force-select these badge types instead of the minimal set. */
  selectOverride?: string[];
}

interface IssuedCode {
  sub: string;
  name?: string;
  badges: MockBadge[];
  nonce?: string;
  codeChallenge: string;
  redirectUri: string;
  /** The `minister_anon_epoch` this grant's id_token is signed with. */
  anonEpoch: number;
}

const pending = new Map<string, PendingAuth>(); // state -> pending auth
const codes = new Map<string, IssuedCode>(); // code -> grant

/**
 * Simulated Minister per-(user, client) grant: the monotone union of badge TYPES
 * a user has ever disclosed to this RP. Phase 3 / Path B: the durable record of
 * "already proven to this platform" lives on the IdP (this mock), NOT on the RP,
 * which keeps no durable badge store. It is the source the transparency
 * "already proven" section would render from. Keyed by `sub` (this mock has a
 * single client). Exposed read-only at `GET /test/grant?sub=...` for specs.
 */
const grants = new Map<string, Set<string>>(); // sub -> granted badge types (union)

/** Record (monotone union) the badge TYPES disclosed to this client for `sub`. */
function recordGrant(sub: string, disclosedTypes: readonly string[]): void {
  const existing = grants.get(sub) ?? new Set<string>();
  for (const t of disclosedTypes) existing.add(t);
  grants.set(sub, existing);
}

/**
 * Test-readable log of the `scope` each /oidc/authorize request asked for, keyed
 * by `state`. Exposed at `GET /test/authorize-log` so disclosure specs can assert
 * that a join requested ONLY the room's required badge scopes (per-room minimal
 * disclosure). In insertion order; the latest entry is the most recent authorize.
 */
const authorizeLog: {
  state: string;
  scope: string;
  scopes: string[];
  /** The raw `minister_policy` param value, or null if the RP sent none (Phase 2). */
  ministerPolicy: string | null;
}[] = [];

/** Badge catalog keys implied by a space-delimited `scope` string. */
function badgeKeysFromScope(scope: string): string[] {
  return scope
    .split(/\s+/)
    .filter((s) => s.startsWith('badge:'))
    .map((s) => s.slice('badge:'.length))
    .filter((slug) => slug in BADGE_CATALOG);
}

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
  'invite-code': { type: 'invite-code', attributes: { label: 'WELCOME' } },
  'oauth-account': {
    type: 'oauth-account',
    attributes: { provider: 'github', handle: 'octocat' },
  },
  'residency-country': { type: 'residency-country', attributes: { country: 'US' } },
  'age-over-18': { type: 'age-over-18', attributes: { threshold: 18 } },
};

// ---- Minister selection simulation (Phase 2) ----------------------------------
//
// The real Minister, given the `minister_policy` requirement, picks the minimal
// satisfying set of badges to disclose - maximizing anonymity (largest holder
// sets) - and lets the user override at consent. The mock issuer simulates this
// faithfully enough for the Discreetly e2e: it decodes the policy, computes a
// single minimal satisfying branch over the badge types the user holds, and mints
// EXACTLY that branch's badges (never the whole union the `scope` lists). This is
// what proves the over-disclosure invariant at the Discreetly boundary: a union
// `scope` does NOT mean a union disclosure.
//
// Anonymity ranking is simulated with a fixed per-type holder-count table (larger
// = more anonymous = preferred). A test may override the selected branch via the
// `minister_policy_select` query param (a comma-separated list of badge types) to
// exercise the "user overrides to a different single branch" path.

/** Simulated distinct-holder counts per badge type (larger = more anonymous). */
const SIMULATED_HOLDER_COUNTS: Record<string, number> = {
  'age-over-18': 5000,
  'residency-country': 200,
  'oauth-account': 3000,
  'email-domain': 1000,
  'invite-code': 50,
};

/** Decode a base64url(JSON) `minister_policy` param into a PolicyNode, or null. */
function decodeMinisterPolicy(param: string): PolicyNode | null {
  try {
    let s = param.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4 !== 0) s += '=';
    const json = Buffer.from(s, 'base64').toString('utf8');
    return JSON.parse(json) as PolicyNode;
  } catch {
    return null;
  }
}

/** Anonymity of a set of types: rank weakest-link-first (smallest holder count). */
function anonymityKey(types: readonly string[]): number[] {
  return types.map((t) => SIMULATED_HOLDER_COUNTS[t] ?? 0).sort((a, b) => a - b);
}

/** Compare two anonymity keys (ascending-sorted holder counts), larger is better. */
function compareAnonymity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!; // larger weakest-link wins
  }
  return b.length - a.length; // fewer badges (shorter) preferred on a tie
}

/**
 * Compute the minimal satisfying type-set for a policy over the user's held
 * types, maximizing anonymity. Returns null if the user cannot satisfy the
 * policy. Each returned set is a list of badge types to disclose.
 */
function selectMinimalSatisfying(node: PolicyNode, held: ReadonlySet<string>): string[] | null {
  if (isBadgeLeaf(node)) {
    return held.has(node.badge.type) ? [node.badge.type] : null;
  }
  if (isAllOf(node)) {
    const parts: string[] = [];
    for (const child of node.allOf) {
      const sel = selectMinimalSatisfying(child, held);
      if (sel === null) return null; // any unsatisfiable child => whole fails
      parts.push(...sel);
    }
    return [...new Set(parts)].sort();
  }
  if (isAnyOf(node)) {
    const candidates = node.anyOf
      .map((c) => selectMinimalSatisfying(c, held))
      .filter((s): s is string[] => s !== null);
    if (candidates.length === 0) return null;
    return pickMostAnonymous(candidates);
  }
  if (isAtLeast(node)) {
    const { n, of } = node.atLeast;
    if (n <= 0) return [];
    const sats = of
      .map((c) => selectMinimalSatisfying(c, held))
      .filter((s): s is string[] => s !== null);
    if (sats.length < n) return null;
    // Take the n most-anonymous satisfiable children, union their selections.
    const topN = sats
      .slice()
      .sort((a, b) => compareAnonymity(anonymityKey(b), anonymityKey(a)))
      .slice(0, n);
    return [...new Set(topN.flat())].sort();
  }
  return null;
}

/** Pick the most-anonymous selection among candidates (weakest-link first). */
function pickMostAnonymous(candidates: string[][]): string[] {
  return candidates.reduce((best, cur) =>
    compareAnonymity(anonymityKey(cur), anonymityKey(best)) > 0 ? cur : best,
  );
}

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
    return json(res, await jwks(Number(new URL(issuer).port)));
  }

  if (path === '/.well-known/did.json') {
    return json(res, await didDocument(Number(new URL(issuer).port)));
  }

  if (path === '/oidc/authorize') return authorize(req, res, url);
  if (path === '/oidc/approve') return approve(req, res);
  if (path === '/oidc/token') return token(req, res, issuer);

  // Test-only: the scope each authorize asked for, newest last. Disclosure specs
  // read this to assert per-room minimal disclosure.
  if (path === '/test/authorize-log') return json(res, { entries: authorizeLog });

  // Test-only: the simulated per-(user, client) grant - the monotone union of
  // badge types this user has ever disclosed to this RP (Path B's IdP-side
  // "already proven to this platform" record). Specs assert the transparency
  // semantics against it. Returns the sorted granted types for `?sub=...`.
  if (path === '/test/grant') {
    const sub = url.searchParams.get('sub') ?? '';
    const types = [...(grants.get(sub) ?? new Set<string>())].sort();
    return json(res, { sub, badgeTypes: types });
  }

  // Test-only: mint an id_token for `sub` at an explicit `minister_anon_epoch`,
  // signed by THIS running issuer's key (so the API verifier accepts it). The
  // re-key test uses it to authorize the epoch-gated `membership.rotate` with a
  // strictly-greater epoch than the one the browser join stamped - the app has
  // no browser rotate control, so the swap primitive is driven directly here.
  if (path === '/test/id-token') {
    const sub = url.searchParams.get('sub') ?? '';
    const epoch = Number(url.searchParams.get('epoch') ?? '1');
    const idToken = await mintIdToken({ issuer, sub, epoch });
    return json(res, { id_token: idToken });
  }

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

  // Record exactly what scope the RP asked for, so specs can assert per-room
  // minimal disclosure (only the room's badges, never the whole wallet).
  const scope = q.get('scope') ?? '';
  // Phase 2: parse the `minister_policy` requirement (if any) and an optional test
  // override of which single branch to disclose (`minister_policy_select`, a
  // comma-separated badge-type list). Both ride the front-channel authorize URL.
  const ministerPolicyParam = q.get('minister_policy');
  authorizeLog.push({
    state,
    scope,
    scopes: scope.split(/\s+/).filter(Boolean),
    ministerPolicy: ministerPolicyParam,
  });

  const ministerPolicy = ministerPolicyParam ? decodeMinisterPolicy(ministerPolicyParam) : null;
  const selectOverride = (q.get('minister_policy_select') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  pending.set(state, {
    state,
    nonce,
    codeChallenge,
    redirectUri,
    scope,
    ministerPolicy,
    selectOverride: selectOverride.length > 0 ? selectOverride : undefined,
  });

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
    // Treat the `badges` query as the held set; Minister selection still applies
    // when a `minister_policy` was sent (over-disclosure invariant in the fast-path).
    const badges = resolveDisclosedBadges(pending.get(state), badgeKeys);
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
  const p = pending.get(state);
  const badges = resolveDisclosedBadges(p, form.getAll('badge'));
  finishLogin(res, state, { sub, name, badges });
}

/**
 * Resolve the badges the issuer actually mints, simulating Minister's disclosure.
 *
 * The "held" types = the union of the requested `badge:` scopes (the menu the RP
 * listed) and any explicitly-checked consent boxes. Then:
 *
 * - With a `minister_policy` (Phase 2): Minister selects ONE minimal satisfying
 *   set over the held types (anonymity-maximizing) - or honors a test override -
 *   and mints EXACTLY that set, never the whole union. If the user holds nothing
 *   satisfying, nothing is minted (the Discreetly gate then denies). This is what
 *   keeps a union `scope` from becoming a union disclosure.
 * - Without a `minister_policy`: today's behavior - mint every held badge (each
 *   requested `badge:` scope is independent).
 */
function resolveDisclosedBadges(p: PendingAuth | undefined, checkedKeys: string[]): MockBadge[] {
  const scopeKeys = p ? badgeKeysFromScope(p.scope) : [];
  const held = new Set<string>([...scopeKeys, ...checkedKeys]);

  let disclosedTypes: string[];
  if (p?.ministerPolicy) {
    if (p.selectOverride && p.selectOverride.length > 0) {
      // Test override: disclose exactly the named types the user actually holds.
      disclosedTypes = p.selectOverride.filter((t) => held.has(t));
    } else {
      disclosedTypes = selectMinimalSatisfying(p.ministerPolicy, held) ?? [];
    }
  } else {
    disclosedTypes = [...held];
  }

  return [...new Set(disclosedTypes)]
    .map((k) => BADGE_CATALOG[k])
    .filter((b): b is MockBadge => b !== undefined);
}

function finishLogin(
  res: ServerResponse,
  state: string,
  user: { sub: string; name?: string; badges: MockBadge[] },
): void {
  const p = pending.get(state)!;
  pending.delete(state);
  // Record the per-(user, client) grant: the monotone union of disclosed types.
  // This is the IdP-side "already proven to this platform" record (Path B); the
  // RP keeps nothing durable. Drives the transparency section at a repeat authorize.
  recordGrant(
    user.sub,
    user.badges.map((b) => b.type),
  );
  const code = randomBytes(24).toString('base64url');
  codes.set(code, {
    sub: user.sub,
    name: user.name,
    badges: user.badges,
    nonce: p.nonce,
    codeChallenge: p.codeChallenge,
    redirectUri: p.redirectUri,
    anonEpoch: DEFAULT_ANON_EPOCH,
  });
  const location = new URL(p.redirectUri);
  location.searchParams.set('code', code);
  location.searchParams.set('state', state);
  // Deliver the Ministry anon-identity branch as a REAL HTTP 3xx `Location`
  // fragment, exactly as live Minister does. The fragment never reaches a server
  // (fragments are not sent in HTTP) and survives the RP's server-side callback
  // hops (Auth.js's callback -> landing page, or the room-auth callback ->
  // room), where the SDK's `extractMinisterAppSecret` captures + scrubs it. Any
  // CLIENT-side redirect in that chain would destroy it - so this must be a 3xx.
  location.hash = anonFragmentParam(user.sub, DEFAULT_ANON_EPOCH);
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
    epoch: grant.anonEpoch,
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
