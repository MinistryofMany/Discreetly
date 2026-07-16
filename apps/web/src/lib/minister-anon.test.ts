/**
 * Ministry anonymous-identity handoff: SDK-backed capture/scrub and the
 * epoch-gated branch adoption (minister-anon.ts). No mix secret and no
 * `/api/minister-anon/*` round trip - the branch is captured from the fragment
 * and adopted keyed by the session sub, gated on the signed id_token epoch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module signals fallbacks through sonner; mock it so tests can assert the
// signal fired without mounting a Toaster.
vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }));
import { toast } from 'sonner';

const SUB = 'pairwise-sub-aaa';
const OTHER_SUB = 'pairwise-sub-bbb';
const BRANCH_KEY = `discreetly.minister.branch.v1:${SUB}`;

// An arbitrary but fixed 32-byte branch (per-app secret) for the fragment.
const BRANCH_BYTES = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const FRAGMENT_VALUE = `v1.${b64url(BRANCH_BYTES)}`;
const EXPECTED_BRANCH_HEX = hex(BRANCH_BYTES);

type Mod = typeof import('./minister-anon');

/** Set the document URL, reset module state, run the synchronous capture. */
async function boot(url: string): Promise<Mod> {
  window.history.replaceState(null, '', url);
  vi.resetModules();
  const mod = await import('./minister-anon');
  mod.captureMinisterAnonFragment();
  return mod;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.mocked(toast.warning).mockClear();
});

describe('captureMinisterAnonFragment + adoptMinisterBranch', () => {
  it('is a byte-identical no-op when no fragment is present: no storage, URL untouched', async () => {
    const mod = await boot('/rooms/abc?x=1');
    mod.adoptMinisterBranch(SUB, 1);
    expect(localStorage.length).toBe(0);
    expect(window.location.pathname + window.location.search).toBe('/rooms/abc?x=1');
    expect(window.location.hash).toBe('');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('captures + scrubs the fragment and adopts the branch keyed by sub', async () => {
    const mod = await boot(`/rooms/abc?roomAuthPickup=p1#minister_anon=${FRAGMENT_VALUE}`);
    // Scrubbed synchronously at capture: the secret is gone; path + search survive.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/rooms/abc?roomAuthPickup=p1');

    mod.adoptMinisterBranch(SUB, 5);
    expect(mod.hasMinisterBranch(SUB)).toBe(true);
    const branch = mod.readMinisterBranch(SUB);
    expect(branch).not.toBeNull();
    expect(hex(branch!)).toBe(EXPECTED_BRANCH_HEX);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('preserves other fragment params while scrubbing only minister_anon', async () => {
    const mod = await boot(`/x#foo=1&minister_anon=${FRAGMENT_VALUE}&bar=2`);
    expect(window.location.hash).toBe('#foo=1&bar=2');
    mod.adoptMinisterBranch(SUB, 1);
    expect(mod.hasMinisterBranch(SUB)).toBe(true);
  });

  it('scrubs but adopts nothing from a malformed / unknown-version value', async () => {
    const mod = await boot('/x#minister_anon=v9.not-a-real-secret');
    expect(window.location.hash).toBe('');
    mod.adoptMinisterBranch(SUB, 1);
    expect(localStorage.length).toBe(0);
    expect(mod.hasMinisterBranch(SUB)).toBe(false);
  });

  it('fails closed with a signal when a branch arrives but the id_token has no epoch', async () => {
    const mod = await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    mod.adoptMinisterBranch(SUB, undefined);
    expect(localStorage.length).toBe(0);
    expect(mod.hasMinisterBranch(SUB)).toBe(false);
    expect(toast.warning).toHaveBeenCalled();
  });

  it('RE-KEY: a strictly greater epoch replaces the stored branch', async () => {
    const first = Uint8Array.from({ length: 32 }, () => 0x11);
    const mod = await boot(`/x#minister_anon=v1.${b64url(first)}`);
    mod.adoptMinisterBranch(SUB, 1);
    const before = mod.readMinisterBranch(SUB);
    expect(hex(before!)).toBe(hex(first));

    // A new login delivers a new branch at a higher epoch -> re-key.
    const mod2 = await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    mod2.adoptMinisterBranch(SUB, 2);
    const after = mod2.readMinisterBranch(SUB);
    expect(hex(after!)).toBe(EXPECTED_BRANCH_HEX);
  });

  it('does NOT re-key at an equal or lower epoch (keeps the stored branch)', async () => {
    const stored = Uint8Array.from({ length: 32 }, () => 0x22);
    const mod = await boot(`/x#minister_anon=v1.${b64url(stored)}`);
    mod.adoptMinisterBranch(SUB, 3);

    // A later login re-delivers a DIFFERENT branch but at the SAME epoch: the
    // signed epoch did not advance, so the stored branch must be kept (a bare
    // commitment/branch mismatch is never a re-key trigger).
    const mod2 = await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    mod2.adoptMinisterBranch(SUB, 3);
    const kept = mod2.readMinisterBranch(SUB);
    expect(hex(kept!)).toBe(hex(stored));
  });

  it('keeps other subs’ branch slots untouched (per-sub keying)', async () => {
    const mod = await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    mod.adoptMinisterBranch(SUB, 1);
    const otherMod = await boot(`/x#minister_anon=v1.${b64url(new Uint8Array(32).fill(9))}`);
    otherMod.adoptMinisterBranch(OTHER_SUB, 1);
    // Both slots present and distinct.
    expect(otherMod.hasMinisterBranch(SUB)).toBe(true);
    expect(otherMod.hasMinisterBranch(OTHER_SUB)).toBe(true);
    expect(hex(otherMod.readMinisterBranch(SUB)!)).toBe(EXPECTED_BRANCH_HEX);
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
    } finally {
      replaceSpy.mockRestore();
    }
    mod.adoptMinisterBranch(SUB, 1);
    // Fail-closed: nothing was adopted (the secret could not be scrubbed) and the
    // fallback was signaled at capture time.
    expect(localStorage.length).toBe(0);
    expect(mod.hasMinisterBranch(SUB)).toBe(false);
    expect(toast.warning).toHaveBeenCalled();
  });
});

describe('readMinisterBranch', () => {
  it('round-trips the cached branch and leaves the cache intact', async () => {
    const mod = await boot(`/x#minister_anon=${FRAGMENT_VALUE}`);
    mod.adoptMinisterBranch(SUB, 1);
    const branch = mod.readMinisterBranch(SUB);
    expect(branch).not.toBeNull();
    expect(hex(branch!)).toBe(EXPECTED_BRANCH_HEX);
    // A second read still works (a fresh buffer each time; the cache is intact).
    expect(hex(mod.readMinisterBranch(SUB)!)).toBe(EXPECTED_BRANCH_HEX);
  });

  it('returns null when absent', async () => {
    const mod = await boot('/x');
    expect(mod.readMinisterBranch(SUB)).toBeNull();
    expect(mod.hasMinisterBranch(SUB)).toBe(false);
  });

  it('returns null (fail-closed) on unreadable or wrong-length cache values', async () => {
    const mod = await boot('/x');
    localStorage.setItem(BRANCH_KEY, JSON.stringify({ b: '!!!not-base64!!!', e: 1 }));
    expect(mod.readMinisterBranch(SUB)).toBeNull();
    localStorage.setItem(BRANCH_KEY, JSON.stringify({ b: btoa('short'), e: 1 }));
    expect(mod.readMinisterBranch(SUB)).toBeNull();
  });
});
