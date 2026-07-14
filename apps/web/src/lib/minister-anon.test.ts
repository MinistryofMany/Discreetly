/**
 * Ministry anonymous-identity handoff: capture/scrub, fail-closed adoption,
 * per-sub non-destructive seed caching (minister-anon.ts).
 *
 * Runs against the REAL @ministryofmany/identity SDK (HKDF via Node's
 * WebCrypto), pinned by the spec 9.2 golden vector: the `deforum` per-app
 * secret from spec 8.1 mixed with utf8("example-rp-mix-secret-32-bytes!!")
 * must derive device seed 09aa8768...b554d5.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module signals fallbacks through sonner; mock it so tests can assert the
// signal fired without mounting a Toaster.
vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }));
import { toast } from 'sonner';

const SUB = 'pairwise-sub-aaa';
const OTHER_SUB = 'pairwise-sub-bbb';
const SEED_KEY = `discreetly.minister.deviceSeed.v1:${SUB}`;

// Spec 8.1 golden per-app secret for anonAppId "deforum".
const APP_SECRET_HEX = 'a6a39187454acc287e62b9eaeabecef8c67bf08500fc53bd5e00912ab0f71a5e';
// Spec 9.2 golden mix secret (exactly 32 utf8 bytes), hex-encoded as the
// /api/minister-anon/rp-mix route serves it.
const MIX_HEX = hex(new TextEncoder().encode('example-rp-mix-secret-32-bytes!!'));
// Spec 9.2 golden derived device seed.
const EXPECTED_SEED_HEX = '09aa876834bad70b4c38e57dbecea98c69f127e240e4eb021ed6d822cab554d5';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const FRAGMENT_VALUE = `v1.${b64url(hexToBytes(APP_SECRET_HEX))}`;
const EXPECTED_CACHED = b64(hexToBytes(EXPECTED_SEED_HEX));

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Set the document URL, reset module state, run capture, await adoption. */
async function boot(url: string) {
  window.history.replaceState(null, '', url);
  vi.resetModules();
  const mod = await import('./minister-anon');
  mod.captureMinisterAnonFragment();
  await mod.ministerAnonSettled();
  return mod;
}

let fetchMock: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn(async () => okResponse({ sub: SUB, mixSecret: MIX_HEX }));
  vi.stubGlobal('fetch', fetchMock);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  warnSpy.mockRestore();
  vi.mocked(toast.warning).mockClear();
});

describe('captureMinisterAnonFragment', () => {
  it('is a byte-identical no-op when no fragment is present: no fetch, no storage, URL untouched', async () => {
    await boot('/rooms/abc?x=1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(window.location.pathname + window.location.search).toBe('/rooms/abc?x=1');
    expect(window.location.hash).toBe('');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('derives the spec 9.2 golden device seed, caches it keyed by sub, and scrubs the URL', async () => {
    await boot(`/rooms/abc?roomAuthPickup=p1#minister_anon=${FRAGMENT_VALUE}`);
    expect(localStorage.getItem(SEED_KEY)).toBe(EXPECTED_CACHED);
    // Scrubbed: the secret is gone from the URL; path + search survive.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/rooms/abc?roomAuthPickup=p1');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('preserves other fragment params while scrubbing only minister_anon', async () => {
    await boot(`/x#foo=1&minister_anon=${FRAGMENT_VALUE}&bar=2`);
    expect(window.location.hash).toBe('#foo=1&bar=2');
    expect(localStorage.getItem(SEED_KEY)).toBe(EXPECTED_CACHED);
  });

  it('scrubs but derives nothing from a malformed / unknown-version value (fail-closed, signaled)', async () => {
    await boot('/x#minister_anon=v9.not-a-real-secret');
    expect(window.location.hash).toBe('');
    expect(localStorage.length).toBe(0);
    expect(toast.warning).toHaveBeenCalled();
  });

  it('fails closed with a signal when the mix secret is unset (mixSecret null)', async () => {
    fetchMock.mockImplementation(async () => okResponse({ sub: SUB, mixSecret: null }));
    await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    expect(localStorage.length).toBe(0);
    expect(toast.warning).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('fails closed when the mix secret is shorter than 32 bytes', async () => {
    fetchMock.mockImplementation(async () => okResponse({ sub: SUB, mixSecret: 'abcd1234' }));
    await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    expect(localStorage.length).toBe(0);
    expect(toast.warning).toHaveBeenCalled();
  });

  it('fails closed with a signal when signed out (401)', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 401 }));
    await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    expect(localStorage.length).toBe(0);
    expect(toast.warning).toHaveBeenCalled();
  });

  it('fails closed with a signal when the mix-secret fetch rejects', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('network down');
    });
    await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    expect(localStorage.length).toBe(0);
    expect(toast.warning).toHaveBeenCalled();
  });

  it('NEVER overwrites a differing existing seed for the same sub (non-destructive), and says so', async () => {
    const preexisting = b64(new Uint8Array(32).fill(7));
    localStorage.setItem(SEED_KEY, preexisting);
    await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    expect(localStorage.getItem(SEED_KEY)).toBe(preexisting);
    expect(toast.warning).toHaveBeenCalled();
  });

  it('leaves other subs’ seed slots untouched (per-sub keying)', async () => {
    const otherKey = `discreetly.minister.deviceSeed.v1:${OTHER_SUB}`;
    const otherSeed = b64(new Uint8Array(32).fill(9));
    localStorage.setItem(otherKey, otherSeed);
    await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    expect(localStorage.getItem(otherKey)).toBe(otherSeed);
    expect(localStorage.getItem(SEED_KEY)).toBe(EXPECTED_CACHED);
  });

  it('never throws out of capture when the scrub fails - warns and does not adopt', async () => {
    window.history.replaceState(null, '', `/x#minister_anon=${FRAGMENT_VALUE}`);
    vi.resetModules();
    const mod = await import('./minister-anon');
    const replaceSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new Error('replaceState unavailable');
    });
    try {
      expect(() => mod.captureMinisterAnonFragment()).not.toThrow();
      await mod.ministerAnonSettled();
    } finally {
      replaceSpy.mockRestore();
    }
    // Fail-closed: no adoption ran (the secret could not be scrubbed), and the
    // fallback was signaled.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(toast.warning).toHaveBeenCalled();
  });

  it('re-deriving the same seed for the same sub is a silent no-op', async () => {
    localStorage.setItem(SEED_KEY, EXPECTED_CACHED);
    await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    expect(localStorage.getItem(SEED_KEY)).toBe(EXPECTED_CACHED);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('readMinisterDeviceSeed', () => {
  it('round-trips the cached seed and leaves the cache intact', async () => {
    const mod = await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    const seed = mod.readMinisterDeviceSeed(SUB);
    expect(seed).not.toBeNull();
    expect(hex(seed!)).toBe(EXPECTED_SEED_HEX);
    expect(localStorage.getItem(SEED_KEY)).toBe(EXPECTED_CACHED);
  });

  it('returns null when absent', async () => {
    const mod = await boot('/x');
    expect(mod.readMinisterDeviceSeed(SUB)).toBeNull();
  });

  it('returns null (fail-closed) on unreadable or wrong-length cache values', async () => {
    const mod = await boot('/x');
    localStorage.setItem(SEED_KEY, '!!!not-base64!!!');
    expect(mod.readMinisterDeviceSeed(SUB)).toBeNull();
    localStorage.setItem(SEED_KEY, b64(new Uint8Array(16).fill(1)));
    expect(mod.readMinisterDeviceSeed(SUB)).toBeNull();
  });
});
