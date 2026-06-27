import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '@discreetly/db';
import { pruneRoomHistory } from './history.js';

const TS = Date.now();
let roomId: string;

/** Seed `n` persisted messages with strictly increasing createdAt and unique nullifiers. */
async function seed(n: number, opts: { tombstoneEvery?: number } = {}): Promise<void> {
  const base = new Date('2026-01-01T00:00:00.000Z').getTime();
  for (let i = 0; i < n; i++) {
    const tomb = opts.tombstoneEvery && (i + 1) % opts.tombstoneEvery === 0;
    await prisma.message.create({
      data: {
        roomId,
        epoch: BigInt(i + 1),
        rlnNullifier: `nf-${TS}-${i}`,
        content: tomb ? '' : `msg-${i}`,
        proof: { snarkProof: { publicSignals: { x: `${i}`, y: `${i}` } } },
        sessionColor: '#abcdef',
        // createdAt is monotonic so recency order is deterministic.
        createdAt: new Date(base + i * 1000),
        ...(tomb ? { deletedAt: new Date(base + i * 1000), deletedBy: 'op' } : {}),
      },
    });
  }
}

beforeEach(async () => {
  await prisma.message.deleteMany({ where: { roomId: { contains: `hist-${TS}` } } });
  await prisma.room.deleteMany({ where: { slug: { contains: `hist-${TS}` } } });
  const room = await prisma.room.create({
    data: {
      name: 'History',
      slug: `hist-${TS}-${Math.random().toString(36).slice(2)}`,
      rlnIdentifier: `${TS}${Math.floor(Math.random() * 1e6)}`,
      rateLimit: 10_000,
      userMessageLimit: 5,
      accessPolicy: {},
    },
  });
  roomId = room.id;
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { roomId } });
  await prisma.room.deleteMany({ where: { id: roomId } });
  await prisma.$disconnect();
});

describe('pruneRoomHistory (ring buffer)', () => {
  it('is a no-op when at or under the cap', async () => {
    await seed(5);
    const { pruned } = await pruneRoomHistory(roomId, 10);
    expect(pruned).toBe(0);
    expect(await prisma.message.count({ where: { roomId } })).toBe(5);
  });

  it('is a no-op at exactly the cap', async () => {
    await seed(10);
    const { pruned } = await pruneRoomHistory(roomId, 10);
    expect(pruned).toBe(0);
    expect(await prisma.message.count({ where: { roomId } })).toBe(10);
  });

  it('keeps exactly the newest `cap` rows and deletes the oldest', async () => {
    await seed(15);
    const { pruned } = await pruneRoomHistory(roomId, 10);
    expect(pruned).toBe(5);

    const remaining = await prisma.message.findMany({
      where: { roomId },
      orderBy: { createdAt: 'asc' },
      select: { content: true },
    });
    expect(remaining.length).toBe(10);
    // The 5 oldest (msg-0..msg-4) are gone; the newest 10 (msg-5..msg-14) remain.
    expect(remaining.map((m) => m.content)).toEqual([
      'msg-5',
      'msg-6',
      'msg-7',
      'msg-8',
      'msg-9',
      'msg-10',
      'msg-11',
      'msg-12',
      'msg-13',
      'msg-14',
    ]);
  });

  it('counts tombstoned rows as occupying a slot (they are pruned/kept by recency, not deleted-state)', async () => {
    // Every 3rd row is a tombstone. With 15 rows, cap 10, the oldest 5 are
    // pruned regardless of tombstone state; tombstones among the newest 10 stay.
    await seed(15, { tombstoneEvery: 3 });
    await pruneRoomHistory(roomId, 10);

    const remaining = await prisma.message.findMany({
      where: { roomId },
      orderBy: { createdAt: 'asc' },
      select: { deletedAt: true },
    });
    expect(remaining.length).toBe(10);
    // Newest 10 are indices 5..14; tombstones at (i+1)%3===0 => i in
    // {2,5,8,11,14}; of those, 5,8,11,14 are within the kept window => 4 tombstones.
    const tombstones = remaining.filter((m) => m.deletedAt !== null).length;
    expect(tombstones).toBe(4);
  });

  it('does not touch other rooms', async () => {
    await seed(15);
    const other = await prisma.room.create({
      data: {
        name: 'Other',
        slug: `hist-${TS}-other-${Math.random().toString(36).slice(2)}`,
        rlnIdentifier: `${TS}${Math.floor(Math.random() * 1e6)}9`,
        rateLimit: 10_000,
        userMessageLimit: 5,
        accessPolicy: {},
      },
    });
    await prisma.message.create({
      data: {
        roomId: other.id,
        epoch: 1n,
        rlnNullifier: `other-nf-${TS}`,
        content: 'other-msg',
        proof: {},
      },
    });
    await pruneRoomHistory(roomId, 10);
    expect(await prisma.message.count({ where: { roomId: other.id } })).toBe(1);
    await prisma.message.deleteMany({ where: { roomId: other.id } });
    await prisma.room.delete({ where: { id: other.id } });
  });
});
