import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, MembershipStatus } from '@discreetly/db';
import { joinRoom, rotateDevice } from './membership.js';

let room: { id: string; rlnIdentifier: string; userMessageLimit: number; maxDevices: number };

beforeAll(async () => {
  const r = await prisma.room.create({
    data: {
      name: 'Mem Test', slug: `mem-${Date.now()}`, rlnIdentifier: `rln-${Date.now()}`,
      rateLimit: 10_000, userMessageLimit: 5, maxDevices: 2,
      accessPolicy: { badge: { type: 'email-domain' } },
    },
  });
  room = { id: r.id, rlnIdentifier: r.rlnIdentifier, userMessageLimit: r.userMessageLimit, maxDevices: r.maxDevices };
});
afterAll(async () => {
  await prisma.room.delete({ where: { id: room.id } });
  await prisma.$disconnect();
});

describe('membership', () => {
  it('joins, adds a second device, then enforces the device limit', async () => {
    const n = 'jn-1';
    const a = await joinRoom({ room, joinNullifier: n, identityCommitment: '111', deviceLabel: 'phone' });
    expect(a.ok).toBe(true);
    const b = await joinRoom({ room, joinNullifier: n, identityCommitment: '222', deviceLabel: 'laptop' });
    expect(b.ok).toBe(true);
    const c = await joinRoom({ room, joinNullifier: n, identityCommitment: '333' });
    expect(c).toMatchObject({ ok: false, reason: 'device-limit' });
    const m = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId: room.id, joinNullifier: n } },
      include: { leaves: true },
    });
    expect(m?.leaves).toHaveLength(2);
  });

  it('is idempotent-ish: re-joining the same device reports already-on-device', async () => {
    const n = 'jn-dup';
    await joinRoom({ room, joinNullifier: n, identityCommitment: '900' });
    const again = await joinRoom({ room, joinNullifier: n, identityCommitment: '900' });
    expect(again).toMatchObject({ ok: false, reason: 'already-on-device' });
  });

  it('rotates a device leaf to a new identity commitment', async () => {
    const n = 'jn-2';
    await joinRoom({ room, joinNullifier: n, identityCommitment: '444' });
    const r = await rotateDevice({ room, joinNullifier: n, oldIdentityCommitment: '444', newIdentityCommitment: '555' });
    expect(r.ok).toBe(true);
    const leaf = await prisma.membershipLeaf.findFirst({ where: { roomId: room.id, identityCommitment: '555' } });
    expect(leaf).toBeTruthy();
  });

  it('does not exceed maxDevices under concurrent joins', async () => {
    const n = 'jn-race';
    await joinRoom({ room, joinNullifier: n, identityCommitment: '1000' }); // 1 of 2 used
    const [r1, r2] = await Promise.all([
      joinRoom({ room, joinNullifier: n, identityCommitment: '1001' }),
      joinRoom({ room, joinNullifier: n, identityCommitment: '1002' }),
    ]);
    expect([r1, r2].filter((r) => r.ok).length).toBe(1);
    const active = await prisma.membershipLeaf.count({
      where: { roomId: room.id, revokedAt: null, membership: { joinNullifier: n } },
    });
    expect(active).toBe(2);
  });

  it('refuses to join when the membership is banned', async () => {
    const n = 'jn-3';
    await joinRoom({ room, joinNullifier: n, identityCommitment: '666' });
    await prisma.membership.update({
      where: { roomId_joinNullifier: { roomId: room.id, joinNullifier: n } },
      data: { status: MembershipStatus.BANNED },
    });
    const again = await joinRoom({ room, joinNullifier: n, identityCommitment: '777' });
    expect(again).toMatchObject({ ok: false, reason: 'banned' });
  });
});
