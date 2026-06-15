import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@discreetly/db';
import { makeProofCtx, proofFor } from '../test/rln-fixtures.js';
import { joinRoom } from '../membership/membership.js';
import { sendMessage } from './pipeline.js';
import { roomMessages } from '../realtime/broadcast.js';

const RATE_LIMIT = 1_000_000;
const ctx = makeProofCtx(778899n, 1n);
const epoch = BigInt(Math.floor(Date.now() / RATE_LIMIT));
let room: { id: string; rlnIdentifier: string; userMessageLimit: number; maxDevices: number };

beforeAll(async () => {
  const r = await prisma.room.create({
    data: {
      name: 'Pipeline Test',
      slug: `pipe-${Date.now()}`,
      rlnIdentifier: `${ctx.rlnIdentifier}`,
      rateLimit: RATE_LIMIT,
      userMessageLimit: 1,
      maxDevices: 5,
      accessPolicy: { badge: { type: 'x' } },
    },
  });
  room = {
    id: r.id,
    rlnIdentifier: r.rlnIdentifier,
    userMessageLimit: r.userMessageLimit,
    maxDevices: r.maxDevices,
  };
  await joinRoom({
    room,
    joinNullifier: 'pipe-jn',
    identityCommitment: ctx.identity.commitment.toString(),
  });
});

afterAll(async () => {
  await prisma.ban.deleteMany({ where: { roomId: room.id } });
  await prisma.message.deleteMany({ where: { roomId: room.id } });
  await prisma.room.delete({ where: { id: room.id } });
  await prisma.$disconnect();
});

describe('message pipeline', () => {
  it('sends a valid message and broadcasts it', async () => {
    const ac = new AbortController();
    const received: unknown[] = [];
    const collect = (async () => {
      for await (const m of roomMessages(room.id, ac.signal)) {
        received.push(m);
        break;
      }
    })();
    await new Promise((r) => setTimeout(r, 200)); // let the subscriber attach

    const proof = await proofFor(ctx, 'hello', epoch);
    const res = await sendMessage({ roomId: room.id, content: 'hello', proof });
    expect(res).toMatchObject({ status: 'sent' });
    const count = await prisma.message.count({ where: { roomId: room.id } });
    expect(count).toBe(1);

    await collect;
    ac.abort();
    expect(received.length).toBe(1);
  });

  it('reports duplicate on the same proof', async () => {
    const proof = await proofFor(ctx, 'hello', epoch); // same content+epoch+messageId => same nullifier+x
    const res = await sendMessage({ roomId: room.id, content: 'hello', proof });
    expect(res).toMatchObject({ status: 'duplicate' });
  });

  it('bans on a colliding second message', async () => {
    const proof = await proofFor(ctx, 'different content', epoch); // same epoch+messageId, diff content => collision
    const res = await sendMessage({ roomId: room.id, content: 'different content', proof });
    expect(res).toMatchObject({ status: 'banned' });
    const m = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId: room.id, joinNullifier: 'pipe-jn' } },
    });
    expect(m?.status).toBe('BANNED');
  });
});
