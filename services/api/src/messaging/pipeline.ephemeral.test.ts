import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@discreetly/db';
import { makeProofCtx, proofFor } from '../test/rln-fixtures.js';
import { joinRoom } from '../membership/membership.js';
import { sendMessage } from './pipeline.js';
import { roomMessages } from '../realtime/broadcast.js';
import { publisher } from '../realtime/redis.js';

const RATE_LIMIT = 1_000_000;
const ctx = makeProofCtx(556677n, 1n);
const epoch = BigInt(Math.floor(Date.now() / RATE_LIMIT));
const JOIN_NULLIFIER = 'eph-jn';
let room: { id: string; rlnIdentifier: string; userMessageLimit: number; maxDevices: number };

beforeAll(async () => {
  const r = await prisma.room.create({
    data: {
      name: 'Ephemeral Test',
      slug: `eph-${Date.now()}`,
      rlnIdentifier: `${ctx.rlnIdentifier}`,
      rateLimit: RATE_LIMIT,
      userMessageLimit: 1,
      maxDevices: 5,
      persistence: 'EPHEMERAL',
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
    joinNullifier: JOIN_NULLIFIER,
    identityCommitment: ctx.identity.commitment.toString(),
  });
});

afterAll(async () => {
  // Purge the transient per-epoch nullifier records this test created.
  const keys = await publisher().keys(`eph:nul:${room.id}:*`);
  if (keys.length) await publisher().del(...keys);
  await prisma.ban.deleteMany({ where: { roomId: room.id } });
  await prisma.message.deleteMany({ where: { roomId: room.id } });
  await prisma.room.delete({ where: { id: room.id } });
  await prisma.$disconnect();
});

describe('ephemeral message pipeline', () => {
  it('relays a valid message over the live feed but persists nothing', async () => {
    const ac = new AbortController();
    const received: unknown[] = [];
    const collect = (async () => {
      for await (const m of roomMessages(room.id, ac.signal)) {
        received.push(m);
        break;
      }
    })();
    await new Promise((r) => setTimeout(r, 200)); // let the subscriber attach

    const proof = await proofFor(ctx, 'transient hello', epoch);
    const res = await sendMessage({ roomId: room.id, content: 'transient hello', proof });
    expect(res).toMatchObject({ status: 'sent' });

    // Nothing is written to the Message table for an ephemeral room.
    const count = await prisma.message.count({ where: { roomId: room.id } });
    expect(count).toBe(0);

    await collect;
    ac.abort();
    expect(received.length).toBe(1);
    expect(received[0]).toMatchObject({ kind: 'message', content: 'transient hello' });
  });

  it('reports duplicate on the same proof without re-broadcasting', async () => {
    const ac = new AbortController();
    const received: unknown[] = [];
    void (async () => {
      for await (const m of roomMessages(room.id, ac.signal)) received.push(m);
    })();
    await new Promise((r) => setTimeout(r, 200));

    const proof = await proofFor(ctx, 'transient hello', epoch); // same content+epoch => same nullifier+x
    const res = await sendMessage({ roomId: room.id, content: 'transient hello', proof });
    expect(res).toMatchObject({ status: 'duplicate' });

    await new Promise((r) => setTimeout(r, 200)); // give any (erroneous) broadcast time to land
    ac.abort();
    expect(received.length).toBe(0); // duplicate must not re-broadcast

    // Still nothing persisted.
    expect(await prisma.message.count({ where: { roomId: room.id } })).toBe(0);
  });

  it('bans on a colliding second message; the ban persists, messages do not', async () => {
    // Same epoch + messageId, different content => same nullifier, different x => collision.
    const proof = await proofFor(ctx, 'spam content', epoch);
    const res = await sendMessage({ roomId: room.id, content: 'spam content', proof });
    expect(res).toMatchObject({ status: 'banned' });

    const m = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId: room.id, joinNullifier: JOIN_NULLIFIER } },
    });
    expect(m?.status).toBe('BANNED');

    const ban = await prisma.ban.findFirst({ where: { roomId: room.id } });
    expect(ban).not.toBeNull();

    // The spammer's leaves are pruned (revoked) by the ban.
    const activeLeaves = await prisma.membershipLeaf.count({
      where: { roomId: room.id, revokedAt: null },
    });
    expect(activeLeaves).toBe(0);

    // Bans persist, but no Message row was ever written for the ephemeral room.
    expect(await prisma.message.count({ where: { roomId: room.id } })).toBe(0);
  });
});
