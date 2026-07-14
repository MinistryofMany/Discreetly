/**
 * CLIENT-SIDE Ministry anonymous-identity handoff (anon-identity master spec
 * 8.4 / 9.3). When Discreetly's OIDC client is anon-enabled on the Minister
 * side (OidcClient.anonAppId set), the Minister consent page appends a per-app
 * secret to the callback redirect as a URL fragment
 * (`#minister_anon=v1.<43 base64url chars>`). The fragment survives the
 * server-side 3xx hops (Auth.js `/api/auth/callback/minister` -> callbackUrl,
 * and `/api/room-auth/callback` -> `/rooms/<id>`) because browsers re-attach
 * the original fragment across redirects whose Location carries no fragment of
 * its own; it never reaches any server (fragments are not sent in HTTP).
 *
 * This module:
 *
 *   1. CAPTURES + SCRUBS the fragment synchronously at providers-module
 *      evaluation - the earliest app-controllable client-side point, before
 *      hydration, before any effect, and before any JS navigation could
 *      destroy the fragment (spec finding S3) or another script could read it
 *      out of the URL (finding S4). The scrub is a local mirror of the SDK's
 *      (history.replaceState removing ONLY the minister_anon param, preserving
 *      router state) because the SDK sits behind a lazy import and the scrub
 *      cannot wait for a chunk load.
 *   2. Asynchronously ADOPTS the captured value: fetches the signed-in user's
 *      pairwise `sub` and the operator-provisioned MINISTER_ANON_RP_MIX_SECRET
 *      from Discreetly's own server (`/api/minister-anon/rp-mix`), validates
 *      the captured value with the SDK's `extractMinisterAppSecret` (synthetic
 *      location, scrub already done), mixes the RP secret in via
 *      `deriveDeviceSeedFromMinister` (HKDF, spec 9.2), and caches the derived
 *      32-byte device seed in localStorage KEYED BY THE MINISTER SUB.
 *
 * Per-sub keying is deliberate (audit finding on the Deforum integration): a
 * single global seed slot lets a second account signing in on the same browser
 * clobber the first account's seed. Here each sub owns its own slot, and a
 * DIFFERING existing seed in the same slot is never overwritten (the cached
 * identity keeps working; a difference means the mix secret or the Ministry
 * seed changed - a fork event that must be surfaced, not silently adopted).
 *
 * The cached device seed feeds the EXISTING identity chain unchanged:
 * `identity-context` `create()` reads it (via `readMinisterDeviceSeed`) and
 * derives the same v3 (trapdoor, nullifier) identity `createIdentity()` would
 * otherwise draw at random - see `deriveIdentityFromDeviceSeed` in
 * `identity.ts`. Everything downstream (encryption at rest, join, RLN proofs,
 * backups) is untouched.
 *
 * FAIL-CLOSED everywhere (spec 8.3): no fragment, a malformed fragment, a
 * signed-out landing, an unset/short mix secret, or any error leaves existing
 * behavior byte-identical (no network call is made unless a fragment actually
 * arrived). Login always succeeds; only the anonymous identity fails to
 * derive, and that fallback is SIGNALED (toast + console.warn), never silent.
 * Nothing here (per-app secret, mix secret, device seed) ever leaves the
 * browser; only the mixed device seed is cached, never the raw per-app secret
 * (spec 9.3). Secret buffers are zeroized (`fill(0)`) as soon as they are no
 * longer needed.
 */
import { toast } from 'sonner';

/** Mirrors MINISTER_ANON_PARAM in @ministryofmany/identity - duplicated because
 *  the capture phase must run synchronously, before the lazy SDK import. */
const PARAM = 'minister_anon';

/** Minimum mix-secret length in bytes (spec 9.2; mirrors RP_MIX_SECRET_MIN_BYTES). */
const MIX_MIN_BYTES = 32;

/** Per-sub localStorage key prefix for the cached (mixed) device seed. */
const SEED_KEY_PREFIX = 'discreetly.minister.deviceSeed.v1:';

let captured = false;
let pending: Promise<void> | null = null;

/**
 * Resolves when any in-flight Minister seed adoption has settled (immediately
 * when none is in flight). Never rejects. `identity-context` awaits this
 * before reading the seed cache so a just-captured handoff can never race an
 * identity creation into the random fallback.
 */
export function ministerAnonSettled(): Promise<void> {
  return pending ?? Promise.resolve();
}

// --- small local codecs (kept dependency-free for the synchronous boot path) ---

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * A fragment ARRIVED but no anonymous identity could be derived: fail closed
 * to existing behavior, and say so - silently falling back would let the user
 * believe their identity is Ministry-recoverable when it is not. Static
 * strings only; no secret material can land in logs or toasts.
 */
function fallbackSignal(reason: string, error?: unknown): void {
  console.warn(
    `minister-anon: a minister_anon fragment arrived but no anonymous identity was derived (${reason}); ` +
      'falling back to existing local-identity behavior (fail-closed)',
    ...(error === undefined ? [] : [error]),
  );
  toast.warning(
    'Your Ministry anonymous identity could not be set up on this device. ' +
      'Sign-in still works; any identity you create here is local-only (not recoverable via Ministry).',
  );
}

async function adopt(raw: string): Promise<void> {
  // 1. Who is signed in, and the operator mix secret - from Discreetly's own
  //    server, per request (never baked into the public bundle, spec 9.2).
  let sub: string | null = null;
  let mixHex: string | null = null;
  try {
    const res = await fetch('/api/minister-anon/rp-mix', { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as { sub?: unknown; mixSecret?: unknown };
      sub = typeof body.sub === 'string' && body.sub.length > 0 ? body.sub : null;
      mixHex = typeof body.mixSecret === 'string' ? body.mixSecret : null;
    }
  } catch (error) {
    fallbackSignal('mix-secret fetch failed', error);
    return;
  }
  if (sub === null) {
    // No session sub -> nothing to key the seed cache by. (A fragment normally
    // lands right after sign-in, so this indicates a broken session.)
    fallbackSignal('no signed-in session');
    return;
  }
  const mix = mixHex === null ? null : hexToBytes(mixHex);
  if (mix === null || mix.byteLength < MIX_MIN_BYTES) {
    // Operator misconfiguration: MINISTER_ANON_RP_MIX_SECRET unset, malformed,
    // or shorter than 32 bytes (the server also warns in its own logs).
    fallbackSignal('MINISTER_ANON_RP_MIX_SECRET unset or shorter than 32 bytes');
    return;
  }

  // 2. Validate + mix. The SDK re-validates the captured value via a synthetic
  //    location (the real URL was already scrubbed), so grammar + decoding stay
  //    in the SDK; Discreetly never re-implements them.
  const { extractMinisterAppSecret, deriveDeviceSeedFromMinister } =
    await import('@ministryofmany/identity');
  const synthetic = new URLSearchParams();
  synthetic.set(PARAM, raw);
  const appSecret = extractMinisterAppSecret({
    location: { pathname: '', search: '', hash: `#${synthetic.toString()}` },
    scrub: false,
  });
  if (appSecret === null) {
    mix.fill(0);
    fallbackSignal('malformed or unknown-version fragment');
    return;
  }
  let seed: Uint8Array;
  try {
    seed = await deriveDeviceSeedFromMinister(appSecret, mix);
  } finally {
    appSecret.fill(0);
    mix.fill(0);
  }

  // 3. Cache the mixed device seed, keyed by the Minister sub. Non-destructive:
  //    a DIFFERING existing seed for the same sub is kept (it is the identity
  //    this device already uses); other subs' slots are never touched.
  try {
    const key = SEED_KEY_PREFIX + sub;
    const next = bytesToBase64(seed);
    const existing = localStorage.getItem(key);
    if (existing === null) {
      localStorage.setItem(key, next);
    } else if (existing !== next) {
      console.warn(
        'minister-anon: the freshly derived device seed differs from the one cached for this ' +
          'account; KEEPING the existing seed (the identity this device already uses). A ' +
          'difference means MINISTER_ANON_RP_MIX_SECRET changed or the Ministry seed was reset - ' +
          'both fork the derived identity (spec invariant I9).',
      );
      toast.warning(
        'This device already holds a different anonymous identity for your account; keeping the existing one.',
      );
    }
    // equal: deterministic re-derivation, nothing to do.
  } finally {
    seed.fill(0);
  }
}

/**
 * Capture + scrub a Ministry anon-identity fragment. MUST be the first
 * client-side act: called at module scope of `providers.tsx`, which evaluates
 * before hydration and therefore before any effect or router navigation (spec
 * finding S3). Idempotent per document load; a fragment only arrives on a
 * full-document navigation (the OIDC callback redirect chain), which always
 * re-evaluates the module, so once per load is correct.
 *
 * The heavy work (session/mix fetch, SDK import, HKDF) runs async after the
 * synchronous scrub; `ministerAnonSettled()` exposes its completion. When no
 * fragment is present this is a pure no-op: no fetch, no storage access -
 * existing behavior byte-identical.
 */
export function captureMinisterAnonFragment(): void {
  if (typeof window === 'undefined' || captured) return;
  captured = true;
  const hash = window.location.hash;
  if (hash === '' || hash === '#') return;

  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const raw = params.get(PARAM);
  if (raw === null) return;

  // Scrub BEFORE validating (mirrors the SDK): even a malformed value is
  // secret-shaped material that must not linger in the URL or the tab's
  // history entry. Only the minister_anon param is removed; other fragment
  // params and router/history state are preserved. This runs at module scope
  // of providers.tsx, so a thrown error here would break app boot for EVERY
  // user - if the scrub itself fails (no usable history.replaceState), fail
  // closed on the anon identity instead: warn and do NOT adopt (never derive
  // from a secret still sitting in the URL).
  params.delete(PARAM);
  const rest = params.toString();
  try {
    window.history.replaceState(
      window.history.state ?? null,
      '',
      window.location.pathname + window.location.search + (rest ? `#${rest}` : ''),
    );
  } catch (error) {
    fallbackSignal('could not scrub the fragment from the URL', error);
    return;
  }

  pending = adopt(raw).catch((error: unknown) => {
    // Fail closed on ANY error (SDK chunk-load failure, WebCrypto absence,
    // storage rejection): existing behavior stands, login is unaffected. SDK
    // error messages are static - no secret material can land in logs.
    fallbackSignal('derivation failed', error);
  });
}

/**
 * The cached Ministry-derived device seed for `sub`, or null when absent or
 * unreadable (fail-closed). Returns a fresh buffer; the CALLER must `fill(0)`
 * it after use.
 */
export function readMinisterDeviceSeed(sub: string): Uint8Array | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(SEED_KEY_PREFIX + sub);
  if (raw === null) return null;
  const bytes = base64ToBytes(raw);
  if (bytes === null || bytes.byteLength !== 32) {
    console.warn(
      'minister-anon: cached device seed for this account is unreadable; ignoring it (fail-closed)',
    );
    return null;
  }
  return bytes;
}
