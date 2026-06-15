import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, MembershipStatus } from '@discreetly/db';
import { makeProofCtx, proofFor } from '../test/rln-fixtures.js';
import { joinRoom } from '../membership/membership.js';
import { banOnCollision } from './ban.js';

const ctx = makeProofCtx(54321n, 1n); // userMessageLimit must match the room's (1)
let room: { id: string; rlnIdentifier: string; userMessageLimit: number; maxDevices: number };

beforeAll(async () => {
  const r = await prisma.room.create({
    data: {
      name: 'Ban Test',
      slug: `ban-${Date.now()}`,
      rlnIdentifier: `${ctx.rlnIdentifier}`,
      rateLimit: 10_000,
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
});
afterAll(async () => {
  await prisma.ban.deleteMany({ where: { roomId: room.id } });
  await prisma.room.delete({ where: { id: room.id } });
  await prisma.$disconnect();
});

describe('banOnCollision', () => {
  it('recovers the secret, bans the membership, prunes all leaves, records a Ban', async () => {
    const joinNullifier = 'ban-jn-1';
    // seat the spammer's device leaf (identityCommitment = the fixture identity's commitment)
    const seated = await joinRoom({
      room,
      joinNullifier,
      identityCommitment: ctx.identity.commitment.toString(),
    });
    expect(seated.ok).toBe(true);

    const p1 = await proofFor(ctx, 'spam one', 42n);
    const p2 = await proofFor(ctx, 'spam two', 42n); // same epoch+messageId, diff message => collision
    const a = p1.snarkProof.publicSignals;
    const b = p2.snarkProof.publicSignals;
    expect(String(a.nullifier)).toBe(String(b.nullifier));

    const outcome = await banOnCollision({
      roomId: room.id,
      userMessageLimit: room.userMessageLimit,
      x1: String(a.x),
      y1: String(a.y),
      x2: String(b.x),
      y2: String(b.y),
    });
    expect(outcome).toMatchObject({ banned: true, joinNullifier, prunedLeaves: 1 });

    const membership = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId: room.id, joinNullifier } },
    });
    expect(membership?.status).toBe(MembershipStatus.BANNED);
    const remainingLeaves = await prisma.membershipLeaf.count({
      where: { membershipId: membership!.id },
    });
    expect(remainingLeaves).toBe(0);
    const ban = await prisma.ban.findFirst({ where: { roomId: room.id, joinNullifier } });
    expect(ban?.reason).toBe('RATE_LIMIT_COLLISION');
    expect(ban?.shamirSecret).toBeTruthy();

    // a banned membership cannot rejoin
    const rejoin = await joinRoom({ room, joinNullifier, identityCommitment: '999' });
    expect(rejoin).toMatchObject({ ok: false, reason: 'banned' });
  });
});
