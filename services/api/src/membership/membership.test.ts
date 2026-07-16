import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, MembershipStatus } from '@discreetly/db';
import { joinRoom, rotateDevice } from './membership.js';

let room: { id: string; rlnIdentifier: string; userMessageLimit: number };

beforeAll(async () => {
  const r = await prisma.room.create({
    data: {
      name: 'Mem Test',
      slug: `mem-${Date.now()}`,
      rlnIdentifier: `rln-${Date.now()}`,
      rateLimit: 10_000,
      userMessageLimit: 5,
      accessPolicy: { badge: { type: 'email-domain' } },
    },
  });
  room = {
    id: r.id,
    rlnIdentifier: r.rlnIdentifier,
    userMessageLimit: r.userMessageLimit,
  };
});
afterAll(async () => {
  await prisma.room.delete({ where: { id: room.id } });
  await prisma.$disconnect();
});

describe('membership', () => {
  it('joins with one leaf and stamps the id_token epoch onto the membership', async () => {
    const n = 'jn-1';
    const a = await joinRoom({ room, joinNullifier: n, identityCommitment: '111', tokenEpoch: 3 });
    expect(a.ok).toBe(true);
    const m = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId: room.id, joinNullifier: n } },
      include: { leaves: true },
    });
    expect(m?.leaves).toHaveLength(1);
    expect(m?.anonEpoch).toBe(3);
  });

  it('is idempotent-ish: re-joining the same commitment reports already-on-device', async () => {
    const n = 'jn-dup';
    await joinRoom({ room, joinNullifier: n, identityCommitment: '900', tokenEpoch: 1 });
    const again = await joinRoom({ room, joinNullifier: n, identityCommitment: '900', tokenEpoch: 1 });
    expect(again).toMatchObject({ ok: false, reason: 'already-on-device' });
  });

  it('allows only one leaf per membership (a different commitment is refused)', async () => {
    const n = 'jn-one-leaf';
    await joinRoom({ room, joinNullifier: n, identityCommitment: '910', tokenEpoch: 1 });
    // A DIFFERENT commitment while a leaf exists is a re-key and must go through
    // rotate (epoch gated), never a second leaf. One leaf per user (D-2).
    const second = await joinRoom({ room, joinNullifier: n, identityCommitment: '911', tokenEpoch: 1 });
    expect(second).toMatchObject({ ok: false, reason: 'device-limit' });
    const active = await prisma.membershipLeaf.count({
      where: { revokedAt: null, membership: { joinNullifier: n } },
    });
    expect(active).toBe(1);
  });

  it('rotates the leaf when the id_token epoch strictly advances', async () => {
    const n = 'jn-2';
    await joinRoom({ room, joinNullifier: n, identityCommitment: '444', tokenEpoch: 1 });
    const r = await rotateDevice({
      room,
      joinNullifier: n,
      newIdentityCommitment: '555',
      tokenEpoch: 2,
    });
    expect(r.ok).toBe(true);
    const leaf = await prisma.membershipLeaf.findFirst({
      where: { roomId: room.id, identityCommitment: '555' },
    });
    expect(leaf).toBeTruthy();
    const m = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId: room.id, joinNullifier: n } },
    });
    expect(m?.anonEpoch).toBe(2);
  });

  // C1 (the RLN-bypass fix): a leaf REPLACEMENT is accepted only when the signed
  // id_token epoch STRICTLY advances past the membership's stored epoch. An
  // equal, lower, or absent epoch is refused with NO write - otherwise a client
  // loops "replace leaf, spam N messages, replace again" for unbounded messages,
  // defeating RLN's per-identity-per-epoch rate limit.
  it('refuses a rotation at an equal, lower, or absent epoch (C1)', async () => {
    const n = 'jn-c1';
    await joinRoom({ room, joinNullifier: n, identityCommitment: '1200', tokenEpoch: 5 });

    // equal epoch -> refused, no write
    const eq = await rotateDevice({
      room,
      joinNullifier: n,
      newIdentityCommitment: '1201',
      tokenEpoch: 5,
    });
    expect(eq).toMatchObject({ ok: false, reason: 'stale-epoch' });

    // lower epoch -> refused, no write
    const lower = await rotateDevice({
      room,
      joinNullifier: n,
      newIdentityCommitment: '1202',
      tokenEpoch: 4,
    });
    expect(lower).toMatchObject({ ok: false, reason: 'stale-epoch' });

    // absent epoch -> refused (cannot advance past anything)
    const none = await rotateDevice({
      room,
      joinNullifier: n,
      newIdentityCommitment: '1203',
      tokenEpoch: undefined,
    });
    expect(none).toMatchObject({ ok: false, reason: 'stale-epoch' });

    // None of the refused replacements touched the leaf or the stored epoch.
    const original = await prisma.membershipLeaf.findFirst({
      where: { roomId: room.id, identityCommitment: '1200' },
    });
    expect(original).toBeTruthy();
    const m = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId: room.id, joinNullifier: n } },
    });
    expect(m?.anonEpoch).toBe(5);
  });

  it('refuses rotation to a commitment already used by another leaf', async () => {
    const a = 'jn-rot-collide-a';
    const b = 'jn-rot-collide-b';
    await joinRoom({ room, joinNullifier: a, identityCommitment: '2000', tokenEpoch: 1 });
    await joinRoom({ room, joinNullifier: b, identityCommitment: '2001', tokenEpoch: 1 });
    const r = await rotateDevice({
      room,
      joinNullifier: a,
      newIdentityCommitment: '2001',
      tokenEpoch: 2,
    });
    expect(r).toMatchObject({ ok: false, reason: 'new-leaf-exists' });
  });

  it('refuses rotation with no membership', async () => {
    const r = await rotateDevice({
      room,
      joinNullifier: 'jn-missing',
      newIdentityCommitment: '3000',
      tokenEpoch: 9,
    });
    expect(r).toMatchObject({ ok: false, reason: 'no-membership' });
  });

  it('refuses to join when the membership is banned', async () => {
    const n = 'jn-3';
    await joinRoom({ room, joinNullifier: n, identityCommitment: '666', tokenEpoch: 1 });
    await prisma.membership.update({
      where: { roomId_joinNullifier: { roomId: room.id, joinNullifier: n } },
      data: { status: MembershipStatus.BANNED },
    });
    const again = await joinRoom({ room, joinNullifier: n, identityCommitment: '777', tokenEpoch: 1 });
    expect(again).toMatchObject({ ok: false, reason: 'banned' });
  });

  it('refuses rotation when the membership is banned', async () => {
    const n = 'jn-ban-rot';
    await joinRoom({ room, joinNullifier: n, identityCommitment: '4000', tokenEpoch: 1 });
    await prisma.membership.update({
      where: { roomId_joinNullifier: { roomId: room.id, joinNullifier: n } },
      data: { status: MembershipStatus.BANNED },
    });
    const r = await rotateDevice({
      room,
      joinNullifier: n,
      newIdentityCommitment: '4001',
      tokenEpoch: 2,
    });
    expect(r).toMatchObject({ ok: false, reason: 'banned' });
  });
});
