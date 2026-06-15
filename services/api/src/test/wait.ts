import { publisher, roomChannel } from '../realtime/redis.js';

/**
 * Poll `predicate` until it returns true or the timeout elapses. Returns true if
 * the condition was met, false on timeout. Used to replace fixed `setTimeout`
 * sleeps in async/Redis tests, which are flaky under CI load.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 3000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Marker `kind` for readiness pings; consumers must filter these out. */
export const READINESS_PING_KIND = '__readiness_ping__';

/**
 * Wait until a `roomMessages` subscriber is actually attached to a room channel.
 *
 * Redis pub/sub does not buffer, so a real broadcast published before the
 * subscriber attaches is lost. This publishes a disposable ping on the room
 * channel until `seen()` reports one was received, proving the subscription is
 * live. Callers filter pings out of their collected messages.
 */
export async function waitForSubscriber(
  roomId: string,
  seen: () => boolean,
  { timeoutMs = 3000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await publisher().publish(roomChannel(roomId), JSON.stringify({ kind: READINESS_PING_KIND }));
    if (await waitFor(seen, { timeoutMs: intervalMs, intervalMs: 5 })) return true;
    if (Date.now() >= deadline) return false;
  }
}
