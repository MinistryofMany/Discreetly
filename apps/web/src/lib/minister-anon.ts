/**
 * CLIENT-SIDE Ministry anonymous-identity handoff.
 *
 * Ministry derives a per-app secret (the "branch" of the user's one-root
 * identity tree) and delivers it to Discreetly's OIDC callback landing page as a
 * URL fragment (`#minister_anon=v1.<43 base64url chars>` = 32 bytes). The
 * fragment survives the server-side 3xx hops and never reaches any server
 * (fragments are not sent in HTTP). This module:
 *
 *   1. CAPTURES + SCRUBS the fragment synchronously at providers-module
 *      evaluation via the SDK's zero-dependency `@ministryofmany/identity/link`
 *      entry - the earliest app-controllable point, before hydration, any
 *      effect, or any router navigation could read or destroy it. The scrub is
 *      the SDK's (`history.replaceState` removing only the `minister_anon`
 *      param), not a hand-rolled mirror.
 *   2. ADOPTS the captured branch once the session is known, keyed by the
 *      signed-in Minister pairwise `sub`, using the SDK's `decideAnonAction`:
 *      the signed `minister_anon_epoch` on the id_token is the SOLE authority on
 *      whether to adopt a first branch, re-key to a new one, or do nothing. A
 *      bare commitment mismatch NEVER triggers a re-key.
 *
 * Per-sub keying: each account owns its own branch slot, so a second account
 * signing in on the same browser cannot clobber the first's. The branch is the
 * user's per-app secret; it and everything derived from it stay browser-local -
 * sending any of it to a server (Discreetly's included) is an integration bug.
 * There is no mix secret and no `/api/minister-anon/*` round trip: the sub the
 * cache is keyed by comes from `useSession()`, which already has it.
 */
import { toast } from 'sonner';
import { extractMinisterAppSecret, decideAnonAction } from '@ministryofmany/identity/link';

/** Per-sub localStorage key prefix for the cached branch + its enrolled epoch. */
const BRANCH_KEY_PREFIX = 'discreetly.minister.branch.v1:';

/** The 32-byte per-app secret captured from the fragment this document load. */
let capturedBranch: Uint8Array | null = null;
let captured = false;

interface StoredBranch {
  /** base64 of the 32-byte branch. */
  b: string;
  /** The signed `minister_anon_epoch` this branch was keyed at. */
  e: number;
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

function branchKey(sub: string): string {
  return BRANCH_KEY_PREFIX + sub;
}

function readStored(sub: string): StoredBranch | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(branchKey(sub));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredBranch>;
    if (typeof parsed.b === 'string' && typeof parsed.e === 'number') {
      return { b: parsed.b, e: parsed.e };
    }
  } catch {
    // Corrupt slot -> treat as absent (fail-closed; a fresh handoff re-keys).
  }
  return null;
}

/**
 * A fragment ARRIVED but no anonymous identity could be adopted: fail closed to
 * existing behavior, and say so - silently falling back would let the user
 * believe their identity is Ministry-derived when it is not. Static strings
 * only; no secret material can land in logs or toasts.
 */
function fallbackSignal(reason: string, error?: unknown): void {
  console.warn(
    `minister-anon: a minister_anon fragment arrived but no anonymous identity was adopted (${reason}); ` +
      'falling back to existing behavior (fail-closed)',
    ...(error === undefined ? [] : [error]),
  );
  toast.warning(
    'Your Ministry anonymous identity could not be set up on this device. ' +
      'Sign-in still works; you may need to sign in again to derive it.',
  );
}

/**
 * Capture + scrub a Ministry anon-identity fragment via the SDK. MUST be the
 * first client-side act: called at module scope of `providers.tsx`, which
 * evaluates before hydration and therefore before any effect or router
 * navigation. Idempotent per document load. No fragment present -> a pure no-op
 * (existing behavior byte-identical).
 *
 * The SDK's `extractMinisterAppSecret` reads `globalThis.location`, scrubs the
 * `minister_anon` param from the URL/history, and returns the 32-byte branch (or
 * null for an absent/malformed/unknown-version fragment). It THROWS only if the
 * scrub itself is impossible (no `history.replaceState`); this runs at module
 * scope, so we fail closed on the anon identity rather than break app boot.
 */
export function captureMinisterAnonFragment(): void {
  if (typeof window === 'undefined' || captured) return;
  captured = true;
  try {
    capturedBranch = extractMinisterAppSecret();
  } catch (error) {
    // Scrub impossible: never derive from a secret still in the URL.
    capturedBranch = null;
    fallbackSignal('could not scrub the fragment from the URL', error);
  }
}

/**
 * Adopt the captured branch for `sub`, gated on the signed `tokenEpoch`. Called
 * from the identity context once the session (sub + id_token epoch) is known.
 * The SDK's `decideAnonAction` decides adopt / rekey / none; only adopt and
 * rekey write, and only when the epoch strictly advances past the stored one.
 * Idempotent: consumes and zeroizes the captured branch, so re-calls are no-ops.
 */
export function adoptMinisterBranch(sub: string, tokenEpoch: number | undefined): void {
  if (capturedBranch === null) return;
  const stored = readStored(sub);
  const action = decideAnonAction({
    branch: capturedBranch,
    tokenEpoch,
    storedEpoch: stored?.e,
  });
  try {
    if (action.action === 'adopt' || action.action === 'rekey') {
      const next: StoredBranch = { b: bytesToBase64(action.branch), e: action.epoch };
      try {
        localStorage.setItem(branchKey(sub), JSON.stringify(next));
      } catch (error) {
        fallbackSignal('could not persist the branch (storage rejected)', error);
      }
    } else if (tokenEpoch === undefined && stored === null) {
      // A branch arrived but the id_token carried no epoch to key on and nothing
      // is stored: fail closed loudly rather than silently drop it.
      fallbackSignal('id_token carried no minister_anon_epoch');
    }
    // 'none' with an existing stored branch: already keyed at this epoch (or a
    // stale token). Keep the stored identity; nothing to do.
  } finally {
    // The captured branch is consumed; zeroize it and prevent reprocessing.
    capturedBranch.fill(0);
    capturedBranch = null;
  }
}

/** True if a Ministry branch is cached for `sub`. */
export function hasMinisterBranch(sub: string): boolean {
  return readStored(sub) !== null;
}

/**
 * The cached Ministry branch (per-app secret) for `sub`, or null when absent or
 * unreadable (fail-closed). Returns a fresh buffer; the CALLER must `fill(0)` it
 * after use.
 */
export function readMinisterBranch(sub: string): Uint8Array | null {
  const stored = readStored(sub);
  if (stored === null) return null;
  const bytes = base64ToBytes(stored.b);
  if (bytes === null || bytes.byteLength !== 32) {
    console.warn(
      'minister-anon: cached branch for this account is unreadable; ignoring it (fail-closed)',
    );
    return null;
  }
  return bytes;
}
