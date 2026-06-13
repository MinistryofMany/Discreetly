import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from './index.js';

describe('db smoke', () => {
  const createdRoomIds: string[] = [];

  async function createRoom(suffix: string): Promise<string> {
    const room = await prisma.room.create({
      data: {
        name: `Smoke Room ${suffix}`,
        slug: `smoke-${suffix}-${Date.now()}`,
        rlnIdentifier: `rln-${suffix}-${Date.now()}`,
        rateLimit: 10_000,
        userMessageLimit: 5,
        accessPolicy: { badge: { type: 'email-domain' } },
      },
    });
    createdRoomIds.push(room.id);
    return room.id;
  }

  afterAll(async () => {
    // Cascade deletes memberships + leaves for each room.
    await prisma.room.deleteMany({ where: { id: { in: createdRoomIds } } });
    await prisma.$disconnect();
  });

  it('groups multiple device leaves under one membership', async () => {
    const roomId = await createRoom('group');

    const membership = await prisma.membership.create({
      data: {
        roomId,
        joinNullifier: 'nullifier-abc',
        leaves: {
          create: [
            { roomId, identityCommitment: 'IC1', rateCommitment: 'RC1', deviceLabel: 'Phone' },
            { roomId, identityCommitment: 'IC2', rateCommitment: 'RC2', deviceLabel: 'Laptop' },
          ],
        },
      },
      include: { leaves: true },
    });
    expect(membership.leaves).toHaveLength(2);

    const fetched = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId, joinNullifier: 'nullifier-abc' } },
      include: { leaves: true },
    });
    expect(fetched?.leaves.map((l) => l.rateCommitment).sort()).toEqual(['RC1', 'RC2']);
  });

  it('rejects a duplicate rateCommitment within the same room', async () => {
    const roomId = await createRoom('dup');

    const membership = await prisma.membership.create({
      data: {
        roomId,
        joinNullifier: 'nullifier-dup',
        leaves: { create: [{ roomId, identityCommitment: 'IC-A', rateCommitment: 'RC-DUP' }] },
      },
    });

    await expect(
      prisma.membershipLeaf.create({
        data: {
          roomId,
          membershipId: membership.id,
          identityCommitment: 'IC-B',
          rateCommitment: 'RC-DUP',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows the same rateCommitment in a different room (per-room scoping)', async () => {
    const roomA = await createRoom('scope-a');
    const roomB = await createRoom('scope-b');

    const membershipA = await prisma.membership.create({
      data: { roomId: roomA, joinNullifier: 'n-a' },
    });
    const membershipB = await prisma.membership.create({
      data: { roomId: roomB, joinNullifier: 'n-b' },
    });

    await prisma.membershipLeaf.create({
      data: {
        roomId: roomA,
        membershipId: membershipA.id,
        identityCommitment: 'IC-x',
        rateCommitment: 'RC-SHARED',
      },
    });
    const leafB = await prisma.membershipLeaf.create({
      data: {
        roomId: roomB,
        membershipId: membershipB.id,
        identityCommitment: 'IC-x',
        rateCommitment: 'RC-SHARED',
      },
    });

    expect(leafB.rateCommitment).toBe('RC-SHARED');
  });
});
