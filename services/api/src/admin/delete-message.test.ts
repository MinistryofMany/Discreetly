import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@discreetly/db';
import { createLocalJWKSet } from 'jose';
import { appRouter } from '../trpc/app.router.js';
import { makeVerifier } from '../minister/verify.js';
import { jwks, signIdToken, MOCK_ISSUER, MOCK_CLIENT_ID } from '../test/mock-issuer.js';
import { deleteMessage } from './delete-message.js';
import { TOMBSTONE_MARKER } from '../realtime/broadcast.js';
import { checkCollision } from '../messaging/collision.js';

const mockVerifier = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  jwks: createLocalJWKSet(await jwks()),
});

const TS = Date.now();
const ADMIN_SUB = `del-admin-${TS}`;
let roomId: string;

const PROOF = {
  snarkProof: { publicSignals: { x: '111', y: '222', root: '0', nullifier: 'nf-1' } },
} as const;

beforeAll(async () => {
  await prisma.adminUser.create({ data: { pairwiseSub: ADMIN_SUB, label: 'del test admin' } });
  const room = await prisma.room.create({
    data: {
      name: 'Del Room',
      slug: `del-${TS}`,
      rlnIdentifier: `${TS}5`,
      rateLimit: 10_000,
      userMessageLimit: 5,
      accessPolicy: {},
    },
  });
  roomId = room.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { action: 'MESSAGE_DELETE', target: roomId } });
  await prisma.message.deleteMany({ where: { roomId } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.adminUser.deleteMany({ where: { pairwiseSub: ADMIN_SUB } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.auditLog.deleteMany({ where: { action: 'MESSAGE_DELETE', target: roomId } });
  await prisma.message.deleteMany({ where: { roomId } });
});

async function seedMessage(content = 'spam') {
  return prisma.message.create({
    data: {
      roomId,
      epoch: 7n,
      rlnNullifier: `nf-${TS}-${Math.random().toString(36).slice(2)}`,
      content,
      proof: PROOF as unknown as object,
      sessionColor: '#ff0000',
    },
  });
}

describe('deleteMessage (operator tombstone core)', () => {
  it('purges content + sessionColor, sets deletedAt/deletedBy, RETAINS rlnNullifier/epoch/proof', async () => {
    const m = await seedMessage();
    const out = await deleteMessage({ messageId: m.id, actor: ADMIN_SUB });
    expect(out).toMatchObject({ ok: true, deleted: true, roomId });

    const row = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
    // Purged user-visible payload.
    expect(row.content).toBe('');
    expect(row.sessionColor).toBeNull();
    // Tombstone stamps.
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(ADMIN_SUB);
    // RLN accounting RETAINED (anonymity-critical).
    expect(row.rlnNullifier).toBe(m.rlnNullifier);
    expect(row.epoch).toBe(7n);
    expect(row.proof).toEqual(PROOF);
  });

  it('writes a MESSAGE_DELETE audit row with only the messageId in metadata', async () => {
    const m = await seedMessage('secret content');
    await deleteMessage({ messageId: m.id, actor: ADMIN_SUB });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'MESSAGE_DELETE', target: roomId },
    });
    expect(audit.actor).toBe(ADMIN_SUB);
    expect(audit.metadata).toEqual({ messageId: m.id });
    // The purged content never appears in the audit metadata.
    expect(JSON.stringify(audit.metadata)).not.toContain('secret content');
  });

  it('is idempotent: a second delete is a no-op and writes no second audit row', async () => {
    const m = await seedMessage();
    await deleteMessage({ messageId: m.id, actor: ADMIN_SUB });
    const out2 = await deleteMessage({ messageId: m.id, actor: ADMIN_SUB });
    expect(out2).toMatchObject({ ok: true, deleted: false, reason: 'already-deleted' });
    const auditCount = await prisma.auditLog.count({
      where: { action: 'MESSAGE_DELETE', target: roomId },
    });
    expect(auditCount).toBe(1);
  });

  it('returns not-found for an unknown id', async () => {
    const out = await deleteMessage({ messageId: 'does-not-exist', actor: ADMIN_SUB });
    expect(out).toEqual({ ok: false, reason: 'not-found' });
  });

  it('RLN collision detection still classifies correctly after a tombstone (slashing survives)', async () => {
    // A prior message under (room, epoch, nullifier) with share point x=111.
    const nf = `nf-${TS}-collide`;
    await prisma.message.create({
      data: {
        roomId,
        epoch: 7n,
        rlnNullifier: nf,
        content: 'first',
        proof: { snarkProof: { publicSignals: { x: '111', y: '222' } } } as unknown as object,
        sessionColor: '#0f0',
      },
    });
    // Tombstone it.
    const prior = await prisma.message.findFirstOrThrow({ where: { roomId, rlnNullifier: nf } });
    await deleteMessage({ messageId: prior.id, actor: ADMIN_SUB });

    // Same x => still a DUPLICATE (proof retained, classification intact).
    const dup = await checkCollision({ roomId, epoch: 7n, nullifier: nf, x: '111' });
    expect(dup.kind).toBe('duplicate');
    // Different x => still a COLLISION exposing the retained prior point.
    const col = await checkCollision({ roomId, epoch: 7n, nullifier: nf, x: '999' });
    expect(col.kind).toBe('collision');
    if (col.kind === 'collision') {
      expect(col.prior).toEqual({ x: '111', y: '222' });
    }
  });
});

describe('admin.deleteMessage (operator-only authz)', () => {
  it('no Authorization header -> UNAUTHORIZED, row unchanged', async () => {
    const m = await seedMessage();
    const caller = appRouter.createCaller({ verify: mockVerifier });
    await expect(caller.admin.deleteMessage({ messageId: m.id })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const row = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.deletedAt).toBeNull();
    expect(row.content).toBe('spam');
  });

  it('valid non-operator token -> FORBIDDEN, row unchanged', async () => {
    const m = await seedMessage();
    const token = await signIdToken({ sub: `not-op-${TS}` });
    const caller = appRouter.createCaller({ verify: mockVerifier, adminIdToken: token });
    await expect(caller.admin.deleteMessage({ messageId: m.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const row = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.deletedAt).toBeNull();
    expect(row.content).toBe('spam');
  });

  it('unknown message id (operator) -> NOT_FOUND', async () => {
    const token = await signIdToken({ sub: ADMIN_SUB });
    const caller = appRouter.createCaller({ verify: mockVerifier, adminIdToken: token });
    await expect(
      caller.admin.deleteMessage({ messageId: 'nope' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('operator token -> tombstones and reports the operator marker via message.list', async () => {
    const m = await seedMessage('to be removed');
    const token = await signIdToken({ sub: ADMIN_SUB });
    const caller = appRouter.createCaller({ verify: mockVerifier, adminIdToken: token });
    const res = await caller.admin.deleteMessage({ messageId: m.id });
    expect(res).toEqual({ ok: true, alreadyDeleted: false });

    const listed = await caller.message.list({ roomId });
    const row = listed.find((x) => x.id === m.id);
    expect(row).toBeDefined();
    expect(row!.content).toBe(TOMBSTONE_MARKER);
    expect(row!.deleted).toBe(true);
    expect(row!.sessionColor).toBeUndefined();
  });
});
