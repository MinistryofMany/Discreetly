import { describe, it, expect } from 'vitest';
import { roomMessages, publishSystem, type RoomBroadcast } from './broadcast.js';

/**
 * Integration test for publishSystem → roomMessages (requires Redis on REDIS_URL).
 * A system broadcast must round-trip as a discriminated-union `{ kind: 'system' }`.
 */
describe('publishSystem round-trip', () => {
  it('yields a { kind: "system", text } payload to a roomMessages subscriber', async () => {
    const roomId = `broadcast-system-${Date.now()}`;
    const ac = new AbortController();

    const gen = roomMessages(roomId, ac.signal);
    const received: RoomBroadcast[] = [];
    const collecting = (async () => {
      for await (const msg of gen) received.push(msg);
    })();

    // Wait for the subscriber to attach.
    await new Promise((r) => setTimeout(r, 200));

    const createdAt = new Date().toISOString();
    await publishSystem(roomId, 'maintenance in 5 minutes', createdAt);

    await new Promise((r) => setTimeout(r, 200));

    ac.abort();
    await collecting;

    expect(received).toHaveLength(1);
    const msg = received[0]!;
    expect(msg.kind).toBe('system');
    if (msg.kind === 'system') {
      expect(msg.text).toBe('maintenance in 5 minutes');
      expect(msg.roomId).toBe(roomId);
      expect(msg.createdAt).toBe(createdAt);
    }
  });
});
