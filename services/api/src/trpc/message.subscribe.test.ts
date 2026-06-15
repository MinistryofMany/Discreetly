import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callProcedure } from '@trpc/server/unstable-core-do-not-import';
import { prisma } from '@discreetly/db';
import { appRouter } from './app.router.js';
import { publishMessage, type BroadcastMessage } from '../realtime/broadcast.js';

const noopVerify = async () => ({ sub: 'x', badges: [] as never[] });

let testRoomId: string;

beforeAll(async () => {
  const room = await prisma.room.create({
    data: {
      name: 'Subscribe Test Room',
      slug: `sub-test-${Date.now()}`,
      rlnIdentifier: String(Date.now() + 7),
      rateLimit: 10_000,
      userMessageLimit: 5,
      visibility: 'PUBLIC',
      accessPolicy: {},
    },
  });
  testRoomId = room.id;
});

afterAll(async () => {
  await prisma.room.delete({ where: { id: testRoomId } });
  await prisma.$disconnect();
});

describe('message.subscribe', () => {
  it('yields a message published to the room', async () => {
    const ac = new AbortController();

    const result = await callProcedure({
      router: appRouter,
      ctx: { verify: noopVerify },
      path: 'message.subscribe',
      type: 'subscription',
      input: { roomId: testRoomId },
      getRawInput: async () => ({ roomId: testRoomId }),
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
      roomId: testRoomId,
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
