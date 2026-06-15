import { describe, it, expect } from 'vitest';
import { callProcedure } from '@trpc/server/unstable-core-do-not-import';
import { appRouter } from './app.router.js';
import { publishMessage, type BroadcastMessage } from '../realtime/broadcast.js';

const noopVerify = async () => ({ sub: 'x', badges: [] as never[] });

describe('message.subscribe', () => {
  it('yields a message published to the room', async () => {
    const ac = new AbortController();

    const result = await callProcedure({
      router: appRouter,
      ctx: { verify: noopVerify },
      path: 'message.subscribe',
      type: 'subscription',
      input: { roomId: 'sub-test-room' },
      getRawInput: async () => ({ roomId: 'sub-test-room' }),
      signal: ac.signal,
      batchIndex: 0,
    });

    // For a subscription, callProcedure returns the AsyncGenerator from the resolver
    const iterable = result as AsyncIterable<BroadcastMessage>;
    const iterator = iterable[Symbol.asyncIterator]();

    // Start consuming in the background so the generator begins executing
    // and the Redis subscriber attaches before we publish
    const nextPromise = iterator.next();

    // Give the Redis subscriber time to attach (mirrors the pattern in pipeline.test.ts)
    await new Promise((r) => setTimeout(r, 200));

    const msg: BroadcastMessage = {
      id: 'm1',
      roomId: 'sub-test-room',
      epoch: '1',
      content: 'hi',
      createdAt: new Date().toISOString(),
    };
    await publishMessage(msg);

    // Now await the first yielded value
    const next = await nextPromise;
    expect(next.done).toBe(false);
    expect((next.value as BroadcastMessage).content).toBe('hi');

    // Abort -> triggers finally in roomMessages -> Redis subscriber quits
    ac.abort();
    await iterator.return?.(undefined);

    // Give Redis a moment to close cleanly
    await new Promise((r) => setTimeout(r, 200));
  });
});
