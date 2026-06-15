import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@discreetly/db';
import { makeProofCtx, proofFor } from '../test/rln-fixtures.js';
import { checkCollision } from './collision.js';

const ctx = makeProofCtx(12345n, 1n);
let roomId: string;

beforeAll(async () => {
  const r = await prisma.room.create({
    data: {
      name: 'Collision Test',
      slug: `col-${Date.now()}`,
      rlnIdentifier: `${ctx.rlnIdentifier}`,
      rateLimit: 10_000,
      userMessageLimit: 1,
      accessPolicy: { badge: { type: 'x' } },
    },
  });
  roomId = r.id;
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { roomId } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.$disconnect();
});

async function store(proof: Awaited<ReturnType<typeof proofFor>>, content: string) {
  const ps = proof.snarkProof.publicSignals;
  await prisma.message.create({
    data: {
      roomId,
      epoch: BigInt(proof.epoch),
      rlnNullifier: String(ps.nullifier),
      content,
      proof: proof as unknown as object,
    },
  });
}

describe('checkCollision', () => {
  it('detects a collision, a duplicate, and a fresh nullifier', async () => {
    const p1 = await proofFor(ctx, 'first', 42n);
    await store(p1, 'first');
    const ps1 = p1.snarkProof.publicSignals;

    // same epoch+messageId, diff content => same nullifier, diff x
    const p2 = await proofFor(ctx, 'second', 42n);
    const ps2 = p2.snarkProof.publicSignals;
    expect(String(ps2.nullifier)).toBe(String(ps1.nullifier));
    const c = await checkCollision({
      roomId,
      epoch: 42n,
      nullifier: String(ps2.nullifier),
      x: String(ps2.x),
    });
    expect(c.kind).toBe('collision');

    const dup = await checkCollision({
      roomId,
      epoch: 42n,
      nullifier: String(ps1.nullifier),
      x: String(ps1.x),
    });
    expect(dup.kind).toBe('duplicate');

    const p3 = await proofFor(ctx, 'later', 43n);
    const ps3 = p3.snarkProof.publicSignals;
    const fresh = await checkCollision({
      roomId,
      epoch: 43n,
      nullifier: String(ps3.nullifier),
      x: String(ps3.x),
    });
    expect(fresh.kind).toBe('new');
  });
});
