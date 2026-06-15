import { describe, it, expect } from 'vitest';
import Redis from 'ioredis';
import { getConfig } from '../config.js';
import {
  roomMessages,
  publishMessage,
  type ChatBroadcast,
  type RoomBroadcast,
} from './broadcast.js';
import { roomChannel } from './redis.js';

/**
 * Integration tests for roomMessages (requires Redis on REDIS_URL).
 *
 * Malformed-payload drop: the try/catch in the 'message' handler absorbs parse
 * errors and logs them; they do not reach the generator or crash the process.
 * This is directly verified by publishing a raw non-JSON string to the channel
 * and confirming it is silently dropped while valid messages still arrive.
 */
describe('roomMessages', () => {
  it('yields valid messages and drops a malformed payload without crashing', async () => {
    const roomId = `broadcast-test-${Date.now()}`;
    const ac = new AbortController();

    const gen = roomMessages(roomId, ac.signal);

    // Collect yielded messages in the background
    const received: RoomBroadcast[] = [];
    const collecting = (async () => {
      for await (const msg of gen) {
        received.push(msg);
      }
    })();

    // Wait for the subscriber to attach
    await new Promise((r) => setTimeout(r, 200));

    // Publish 2 valid messages, then 1 malformed, then 3 more valid
    const pub = new Redis(getConfig().REDIS_URL);
    const channel = roomChannel(roomId);

    const makeMsg = (n: number): ChatBroadcast => ({
      kind: 'message',
      id: `m${n}`,
      roomId,
      epoch: String(n),
      content: `msg-${n}`,
      createdAt: new Date().toISOString(),
    });

    await pub.publish(channel, JSON.stringify(makeMsg(1)));
    await pub.publish(channel, JSON.stringify(makeMsg(2)));
    // Malformed payload — not valid JSON
    await pub.publish(channel, 'this is {not json}');
    await pub.publish(channel, JSON.stringify(makeMsg(3)));
    await pub.publish(channel, JSON.stringify(makeMsg(4)));
    await pub.publish(channel, JSON.stringify(makeMsg(5)));

    // Wait for messages to be delivered
    await new Promise((r) => setTimeout(r, 300));

    // Abort and let the generator finish
    ac.abort();
    await collecting;

    await pub.quit();

    // Exactly 5 valid messages; the malformed one was silently dropped
    expect(received).toHaveLength(5);
    expect(received.map((m) => (m.kind === 'message' ? m.id : undefined))).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ]);
  });

  it('completes cleanly after abort with no lingering listeners', async () => {
    const roomId = `broadcast-abort-${Date.now()}`;
    const ac = new AbortController();

    const gen = roomMessages(roomId, ac.signal);
    const received: RoomBroadcast[] = [];

    const collecting = (async () => {
      for await (const msg of gen) {
        received.push(msg);
      }
    })();

    await new Promise((r) => setTimeout(r, 150));

    await publishMessage({
      id: 'a1',
      roomId,
      epoch: '1',
      content: 'hello',
      createdAt: new Date().toISOString(),
    });
    await publishMessage({
      id: 'a2',
      roomId,
      epoch: '2',
      content: 'world',
      createdAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 200));

    // Abort — the finally block should removeEventListener and quit the subscriber
    ac.abort();
    await collecting;

    expect(received.length).toBeGreaterThanOrEqual(2);
    // No assertion on listener count (not exposed), but the generator must complete
    // without hanging — if it hung, vitest would time out this test.
  });
});
