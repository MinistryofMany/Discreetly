import { publisher } from '../realtime/redis.js';
import { getConfig } from '../config.js';

export interface RateLimitResult {
  /** Whether the request is permitted under the current window. */
  allowed: boolean;
  /** Remaining requests allowed in the current window (>= 0). */
  remaining: number;
  /** Milliseconds until the current window resets. */
  resetMs: number;
}

/**
 * Atomic fixed-window counter. INCRs the key; on the first hit (count === 1)
 * sets the window TTL. Returns the post-increment count and the remaining TTL
 * in milliseconds, so callers compute `allowed` and `Retry-After` without a
 * race between INCR and EXPIRE.
 */
const FIXED_WINDOW_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
`;

const KEY_PREFIX = 'rl:';

/**
 * Redis-backed fixed-window rate limit check. Atomic across instances.
 * When `RATE_LIMIT_ENABLED=false`, this is a no-op that always allows (so the
 * test/e2e harnesses never flake on limits).
 *
 * @param key      Logical bucket key (e.g. `mutation:1.2.3.4`). Prefixed in Redis.
 * @param max      Max requests permitted per window.
 * @param windowMs Window length in milliseconds.
 */
export async function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<RateLimitResult> {
  if (!getConfig().RATE_LIMIT_ENABLED) {
    return { allowed: true, remaining: max, resetMs: 0 };
  }

  const redis = publisher();
  const raw = (await redis.eval(FIXED_WINDOW_LUA, 1, `${KEY_PREFIX}${key}`, String(windowMs))) as [
    number,
    number,
  ];
  const count = Number(raw[0]);
  const ttl = Number(raw[1]);
  // PTTL returns -1 (no expiry) or -2 (no key) in edge cases; fall back to the
  // full window so Retry-After is never negative.
  const resetMs = ttl >= 0 ? ttl : windowMs;
  const remaining = Math.max(0, max - count);

  return { allowed: count <= max, remaining, resetMs };
}
