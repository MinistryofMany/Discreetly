import { describe, it, expect, afterAll } from 'vitest';
import { checkRateLimit } from './rate-limit.js';
import { publisher } from '../realtime/redis.js';
import { getConfig } from '../config.js';

// These tests exercise the real dev Redis. They require RATE_LIMIT_ENABLED to be
// on (the default); the suite asserts the no-op path by toggling the cached
// config below.
const enabled = getConfig().RATE_LIMIT_ENABLED;

const uniqueKey = (label: string): string => `test:${label}:${Date.now()}:${Math.random()}`;

afterAll(async () => {
  await publisher().quit();
});

describe('checkRateLimit', () => {
  it.skipIf(!enabled)('allows requests under the max', async () => {
    const key = uniqueKey('under');
    const r1 = await checkRateLimit(key, 3, 10_000);
    const r2 = await checkRateLimit(key, 3, 10_000);
    const r3 = await checkRateLimit(key, 3, 10_000);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it.skipIf(!enabled)('rejects requests over the max', async () => {
    const key = uniqueKey('over');
    for (let i = 0; i < 2; i++) await checkRateLimit(key, 2, 10_000);
    const overflow = await checkRateLimit(key, 2, 10_000);
    expect(overflow.allowed).toBe(false);
    expect(overflow.remaining).toBe(0);
    expect(overflow.resetMs).toBeGreaterThan(0);
  });

  it.skipIf(!enabled)('resets after the window elapses', async () => {
    const key = uniqueKey('reset');
    const first = await checkRateLimit(key, 1, 300);
    const blocked = await checkRateLimit(key, 1, 300);
    expect(first.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    const afterWindow = await checkRateLimit(key, 1, 300);
    expect(afterWindow.allowed).toBe(true);
  });

  it.skipIf(!enabled)('keeps separate keys/buckets independent', async () => {
    const a = uniqueKey('indep-a');
    const b = uniqueKey('indep-b');
    await checkRateLimit(a, 1, 10_000);
    const aBlocked = await checkRateLimit(a, 1, 10_000);
    const bAllowed = await checkRateLimit(b, 1, 10_000);
    expect(aBlocked.allowed).toBe(false);
    expect(bAllowed.allowed).toBe(true);
  });

  it('is a no-op when disabled', async () => {
    // Force the disabled path by mutating the cached config object.
    const cfg = getConfig() as { RATE_LIMIT_ENABLED: boolean };
    const original = cfg.RATE_LIMIT_ENABLED;
    cfg.RATE_LIMIT_ENABLED = false;
    try {
      const key = uniqueKey('noop');
      for (let i = 0; i < 10; i++) {
        const r = await checkRateLimit(key, 1, 10_000);
        expect(r.allowed).toBe(true);
      }
    } finally {
      cfg.RATE_LIMIT_ENABLED = original;
    }
  });
});
