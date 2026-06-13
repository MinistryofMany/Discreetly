import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from './index.js';

describe('db smoke', () => {
  let roomId: string;

  beforeAll(async () => {
    const room = await prisma.room.create({
      data: {
        name: 'Smoke Room',
        slug: `smoke-${Date.now()}`,
        rlnIdentifier: `rln-${Date.now()}`,
        rateLimit: 10_000,
        userMessageLimit: 5,
        accessPolicy: { badge: { type: 'email-domain' } },
      },
    });
    roomId = room.id;
  });

  afterAll(async () => {
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.$disconnect();
  });

  it('groups multiple device leaves under one membership', async () => {
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

  it('rejects a duplicate rateCommitment in the same room', async () => {
    await expect(
      prisma.membershipLeaf.create({
        data: { roomId, membershipId: (await firstMembership(roomId)).id, identityCommitment: 'IC3', rateCommitment: 'RC1' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

async function firstMembership(roomId: string) {
  const m = await prisma.membership.findFirst({ where: { roomId } });
  if (!m) throw new Error('expected a membership');
  return m;
}
