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

// `currentEpoch` for prunes that exercise count-based behavior on aged-out
// rows. `seed(n)` writes epochs 1..n, so any value strictly greater than n+1
// puts every seeded row outside the live window (`currentEpoch ± 1`) and lets
// the count-based prune apply to all of them. 1_000_000 is comfortably beyond
// any seeded epoch in this suite.
const AGED_OUT_EPOCH = 1_000_000n;

describe('pruneRoomHistory (ring buffer)', () => {
  it('is a no-op when at or under the cap', async () => {
    await seed(5);
    const { pruned } = await pruneRoomHistory(roomId, AGED_OUT_EPOCH, 10);
    expect(pruned).toBe(0);
    expect(await prisma.message.count({ where: { roomId } })).toBe(5);
  });

  it('is a no-op at exactly the cap', async () => {
    await seed(10);
    const { pruned } = await pruneRoomHistory(roomId, AGED_OUT_EPOCH, 10);
    expect(pruned).toBe(0);
    expect(await prisma.message.count({ where: { roomId } })).toBe(10);
  });

  it('keeps exactly the newest `cap` rows and deletes the oldest', async () => {
    await seed(15);
    const { pruned } = await pruneRoomHistory(roomId, AGED_OUT_EPOCH, 10);
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
    await pruneRoomHistory(roomId, AGED_OUT_EPOCH, 10);

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
    await pruneRoomHistory(roomId, AGED_OUT_EPOCH, 10);
    expect(await prisma.message.count({ where: { roomId: other.id } })).toBe(1);
    await prisma.message.deleteMany({ where: { roomId: other.id } });
    await prisma.room.delete({ where: { id: other.id } });
  });
});

describe('pruneRoomHistory — RLN live-window protection (audit M1)', () => {
  const CURRENT_EPOCH = 5_000n;
  const base = new Date('2026-02-01T00:00:00.000Z').getTime();

  /** Insert one message with an explicit epoch/createdAt and a unique nullifier. */
  async function insert(args: { epoch: bigint; createdAt: Date; tag: string }): Promise<void> {
    await prisma.message.create({
      data: {
        roomId,
        epoch: args.epoch,
        rlnNullifier: `m1-${TS}-${args.tag}`,
        content: args.tag,
        proof: { snarkProof: { publicSignals: { x: '0', y: '0' } } },
        createdAt: args.createdAt,
      },
    });
  }

  it('does NOT prune a live-window message even when >cap strictly-newer rows exist (M1 flood)', async () => {
    // The exact flood M1 closes: one message in the live collision window
    // (`epoch === currentEpoch`) but with the OLDEST createdAt, then a flood of
    // strictly-newer rows that are all outside the live window. With a small cap
    // the count-based prune would, pre-fix, evict the live-window row as "oldest"
    // and destroy the prior point the slashing path needs.
    await insert({ epoch: CURRENT_EPOCH, createdAt: new Date(base), tag: 'live' });
    const cap = 10;
    const flood = cap + 5; // 15 strictly-newer, aged-out rows
    for (let i = 0; i < flood; i++) {
      await insert({
        epoch: CURRENT_EPOCH - 100n, // far outside currentEpoch ± 1
        createdAt: new Date(base + (i + 1) * 1000), // all newer than the live row
        tag: `flood-${i}`,
      });
    }

    const { pruned } = await pruneRoomHistory(roomId, CURRENT_EPOCH, cap);

    // 16 total rows (1 live + 15 flood), cap 10. Ordered newest→oldest by
    // createdAt: flood-14..flood-0, then `live` (oldest). The boundary is the
    // 10th-newest = flood-5; rows strictly older than it are {flood-4..flood-0,
    // live} = 6 candidates. Pre-fix the count predicate would prune all 6,
    // EVICTING the live-window row. The M1 epoch guard (`epoch < currentEpoch-1`)
    // excludes `live`, so only the 5 aged-out rows flood-0..flood-4 are deleted
    // and the live row transiently keeps the room one over cap (11 rows).
    const live = await prisma.message.findFirst({
      where: { roomId, content: 'live' },
      select: { id: true },
    });
    expect(live).not.toBeNull();
    expect(pruned).toBe(5);
    const remaining = await prisma.message.findMany({
      where: { roomId },
      orderBy: [{ createdAt: 'asc' }],
      select: { content: true },
    });
    // live row + flood-5..flood-14 (10 newest aged-out) = 11 kept (one over cap,
    // the bounded transient overshoot M1 accepts).
    expect(remaining.map((m) => m.content)).toEqual([
      'live',
      'flood-5',
      'flood-6',
      'flood-7',
      'flood-8',
      'flood-9',
      'flood-10',
      'flood-11',
      'flood-12',
      'flood-13',
      'flood-14',
    ]);
  });

  it('protects all three live epochs (currentEpoch-1, currentEpoch, currentEpoch+1) and prunes just outside', async () => {
    // Oldest-by-createdAt rows spanning the window boundary. currentEpoch-2 is
    // just outside the live window and MUST be prunable; currentEpoch-1 is in it
    // and MUST be kept.
    await insert({ epoch: CURRENT_EPOCH - 2n, createdAt: new Date(base), tag: 'below' });
    await insert({ epoch: CURRENT_EPOCH - 1n, createdAt: new Date(base + 1000), tag: 'lo' });
    await insert({ epoch: CURRENT_EPOCH, createdAt: new Date(base + 2000), tag: 'mid' });
    await insert({ epoch: CURRENT_EPOCH + 1n, createdAt: new Date(base + 3000), tag: 'hi' });
    // Flood of strictly-newer aged-out rows to drive the count well over cap.
    const cap = 3;
    for (let i = 0; i < 10; i++) {
      await insert({
        epoch: CURRENT_EPOCH - 100n,
        createdAt: new Date(base + (4 + i) * 1000),
        tag: `pad-${i}`,
      });
    }

    await pruneRoomHistory(roomId, CURRENT_EPOCH, cap);

    const kept = await prisma.message.findMany({
      where: { roomId },
      select: { content: true },
    });
    const keptTags = new Set(kept.map((m) => m.content));
    // All three live-window rows survive regardless of recency/cap.
    expect(keptTags.has('lo')).toBe(true);
    expect(keptTags.has('mid')).toBe(true);
    expect(keptTags.has('hi')).toBe(true);
    // The just-outside-window oldest row is prunable and was pruned (it is the
    // oldest by createdAt and far over cap).
    expect(keptTags.has('below')).toBe(false);
  });
});
