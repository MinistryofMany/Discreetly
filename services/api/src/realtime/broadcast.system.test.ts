import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { roomMessages, publishSystem, type RoomBroadcast } from './broadcast.js';
import { waitFor, waitForSubscriber, READINESS_PING_KIND } from '../test/wait.js';

/** Drop readiness pings injected by waitForSubscriber. */
function realMessages(received: RoomBroadcast[]): RoomBroadcast[] {
  return received.filter((m) => (m as { kind?: string }).kind !== READINESS_PING_KIND);
}

/**
 * Integration test for publishSystem → roomMessages (requires Redis on REDIS_URL).
 * A system broadcast must round-trip as a discriminated-union `{ kind: 'system' }`.
 */
describe('publishSystem round-trip', () => {
  it('yields a { kind: "system", text } payload to a roomMessages subscriber', async () => {
    const roomId = `broadcast-system-${randomUUID()}`;
    const ac = new AbortController();

    const gen = roomMessages(roomId, ac.signal);
    const received: RoomBroadcast[] = [];
    const collecting = (async () => {
      for await (const msg of gen) received.push(msg);
    })();

    // Wait until the subscriber is actually attached (Redis pub/sub is not buffered).
    await waitForSubscriber(roomId, () => received.length > 0);

    const createdAt = new Date().toISOString();
    await publishSystem(roomId, 'maintenance in 5 minutes', createdAt);

    await waitFor(() => realMessages(received).length > 0);

    ac.abort();
    await collecting;

    const real = realMessages(received);
    expect(real).toHaveLength(1);
    const msg = real[0]!;
    expect(msg.kind).toBe('system');
    if (msg.kind === 'system') {
      expect(msg.text).toBe('maintenance in 5 minutes');
      expect(msg.roomId).toBe(roomId);
      expect(msg.createdAt).toBe(createdAt);
    }
  });
});
