import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@discreetly/db';
import { createLocalJWKSet } from 'jose';
import { appRouter } from '../trpc/app.router.js';
import { makeVerifier } from '../minister/verify.js';
import {
  jwks,
  signIdToken,
  MOCK_ISSUER,
  MOCK_VC_ISSUER,
  MOCK_CLIENT_ID,
} from '../test/mock-issuer.js';
import { OPEN_POLICY } from '@discreetly/policy';
import { hashRoomPassword, verifyRoomPassword } from './room-crypto.js';

const mockVerifier = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  vcIssuer: MOCK_VC_ISSUER,
  jwks: createLocalJWKSet(await jwks()),
});

const ADMIN_SUB = `room-admin-${randomUUID()}`;
/** Unique slug per call so shared-DB runs never collide. */
const uniqueSlug = (prefix: string): string => `${prefix}-${randomUUID()}`;
const createdRoomIds: string[] = [];

async function adminCaller() {
  const adminIdToken = await signIdToken({ sub: ADMIN_SUB });
  return appRouter.createCaller({ verify: mockVerifier, adminIdToken });
}

beforeAll(async () => {
  await prisma.adminUser.create({ data: { pairwiseSub: ADMIN_SUB, label: 'room crud admin' } });
});

afterAll(async () => {
  for (const id of createdRoomIds) {
    await prisma.room.deleteMany({ where: { id } });
  }
  await prisma.auditLog.deleteMany({ where: { actor: ADMIN_SUB } });
  await prisma.adminUser.deleteMany({ where: { pairwiseSub: ADMIN_SUB } });
  await prisma.$disconnect();
});

describe('admin room CRUD', () => {
  it('creates an open room: row exists, rlnIdentifier is numeric, no passwordHash in response', async () => {
    const caller = await adminCaller();
    const slug = uniqueSlug('open-room');
    const result = await caller.admin.room.create({
      name: 'Open Room',
      slug,
      rateLimit: 10_000,
      userMessageLimit: 5,
      accessPolicy: OPEN_POLICY,
    });

    createdRoomIds.push(result.id);

    expect(result).not.toHaveProperty('passwordHash');
    expect(result.slug).toBe(slug);
    expect(result.name).toBe('Open Room');
    // rlnIdentifier must be a valid numeric string (bigint)
    expect(() => BigInt(result.rlnIdentifier)).not.toThrow();

    const row = await prisma.room.findUnique({ where: { id: result.id } });
    expect(row).not.toBeNull();
    expect(row!.rlnIdentifier).toBe(result.rlnIdentifier);
  });

  it('creates an AES room with password: passwordHash stored in DB, not in response', async () => {
    const caller = await adminCaller();
    const slug = uniqueSlug('aes-room');
    const result = await caller.admin.room.create({
      name: 'AES Room',
      slug,
      rateLimit: 10_000,
      userMessageLimit: 5,
      encryption: 'AES',
      password: 'super-secret',
      accessPolicy: OPEN_POLICY,
    });

    createdRoomIds.push(result.id);

    expect(result).not.toHaveProperty('passwordHash');

    const row = await prisma.room.findUnique({ where: { id: result.id } });
    expect(row?.passwordHash).toBeTruthy();
    expect(row?.passwordHash).toMatch(/^scrypt\$/);
    expect(row?.encryption).toBe('AES');
  });

  it('rlnIdentifier is unique across two created rooms', async () => {
    const caller = await adminCaller();
    const r1 = await caller.admin.room.create({
      name: 'Unique Test 1',
      slug: uniqueSlug('unique-1'),
      rateLimit: 1000,
      userMessageLimit: 3,
      accessPolicy: OPEN_POLICY,
    });
    const r2 = await caller.admin.room.create({
      name: 'Unique Test 2',
      slug: uniqueSlug('unique-2'),
      rateLimit: 1000,
      userMessageLimit: 3,
      accessPolicy: OPEN_POLICY,
    });

    createdRoomIds.push(r1.id, r2.id);
    expect(r1.rlnIdentifier).not.toBe(r2.rlnIdentifier);
  });

  it('rejects an invalid accessPolicy (bare {})', async () => {
    const caller = await adminCaller();
    await expect(
      caller.admin.room.create({
        name: 'Bad Policy',
        slug: uniqueSlug('bad-policy'),
        rateLimit: 1000,
        userMessageLimit: 3,
        accessPolicy: {} as never,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects AES room without a password', async () => {
    const caller = await adminCaller();
    await expect(
      caller.admin.room.create({
        name: 'AES No Password',
        slug: uniqueSlug('aes-no-pw'),
        rateLimit: 1000,
        userMessageLimit: 3,
        encryption: 'AES',
        accessPolicy: OPEN_POLICY,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('update changes fields and re-validates policy', async () => {
    const caller = await adminCaller();
    const created = await caller.admin.room.create({
      name: 'Update Test',
      slug: uniqueSlug('update-test'),
      rateLimit: 1000,
      userMessageLimit: 3,
      accessPolicy: OPEN_POLICY,
    });
    createdRoomIds.push(created.id);

    const updated = await caller.admin.room.update({
      id: created.id,
      name: 'Updated Name',
      accessPolicy: { allOf: [] },
    });

    expect(updated.name).toBe('Updated Name');
    expect(updated).not.toHaveProperty('passwordHash');
    // rlnIdentifier must not change
    expect(updated.rlnIdentifier).toBe(created.rlnIdentifier);
  });

  it('update with invalid accessPolicy is rejected', async () => {
    const caller = await adminCaller();
    const created = await caller.admin.room.create({
      name: 'Update Policy Test',
      slug: uniqueSlug('update-policy'),
      rateLimit: 1000,
      userMessageLimit: 3,
      accessPolicy: OPEN_POLICY,
    });
    createdRoomIds.push(created.id);

    await expect(
      caller.admin.room.update({ id: created.id, accessPolicy: { foo: 'bar' } as never }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('update 404 on missing id', async () => {
    const caller = await adminCaller();
    await expect(
      caller.admin.room.update({ id: 'does-not-exist', name: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('delete removes the room and cascades memberships', async () => {
    const caller = await adminCaller();
    const created = await caller.admin.room.create({
      name: 'Delete Test',
      slug: uniqueSlug('delete-test'),
      rateLimit: 1000,
      userMessageLimit: 3,
      accessPolicy: OPEN_POLICY,
    });

    // Seed a membership so we can verify cascade
    const membership = await prisma.membership.create({
      data: {
        roomId: created.id,
        joinNullifier: `jn-del-${randomUUID()}`,
      },
    });

    const result = await caller.admin.room.delete({ id: created.id });
    expect(result).toEqual({ ok: true });

    const row = await prisma.room.findUnique({ where: { id: created.id } });
    expect(row).toBeNull();

    const mem = await prisma.membership.findUnique({ where: { id: membership.id } });
    expect(mem).toBeNull();
  });

  it('delete 404 on missing id', async () => {
    const caller = await adminCaller();
    await expect(caller.admin.room.delete({ id: 'does-not-exist' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('list includes PRIVATE rooms', async () => {
    const caller = await adminCaller();
    const slug = uniqueSlug('private-room');
    const created = await caller.admin.room.create({
      name: 'Private Room',
      slug,
      rateLimit: 1000,
      userMessageLimit: 3,
      visibility: 'PRIVATE',
      accessPolicy: OPEN_POLICY,
    });
    createdRoomIds.push(created.id);

    const rooms = await caller.admin.room.list();
    const found = rooms.find((r) => r.id === created.id);
    expect(found).toBeDefined();
    expect(found?.visibility).toBe('PRIVATE');
    // No passwordHash in any listed room
    for (const r of rooms) {
      expect(r).not.toHaveProperty('passwordHash');
    }
  });

  it('list includes _count of memberships and messages', async () => {
    const caller = await adminCaller();
    const rooms = await caller.admin.room.list();
    for (const r of rooms) {
      expect(r).toHaveProperty('_count');
      expect(r._count).toHaveProperty('memberships');
      expect(r._count).toHaveProperty('messages');
    }
  });

  it('room.get returns any room by id, no passwordHash', async () => {
    const caller = await adminCaller();
    const slug = uniqueSlug('get-test');
    const created = await caller.admin.room.create({
      name: 'Get Test',
      slug,
      rateLimit: 1000,
      userMessageLimit: 3,
      visibility: 'PRIVATE',
      accessPolicy: OPEN_POLICY,
    });
    createdRoomIds.push(created.id);

    const fetched = await caller.admin.room.get({ id: created.id });
    expect(fetched.id).toBe(created.id);
    expect(fetched).not.toHaveProperty('passwordHash');
  });

  it('room.get 404 on missing id', async () => {
    const caller = await adminCaller();
    await expect(caller.admin.room.get({ id: 'does-not-exist' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('audit rows written for create, update, delete', async () => {
    const caller = await adminCaller();
    const slug = uniqueSlug('audit-test');
    const created = await caller.admin.room.create({
      name: 'Audit Test',
      slug,
      rateLimit: 1000,
      userMessageLimit: 3,
      accessPolicy: OPEN_POLICY,
    });

    const createLogs = await prisma.auditLog.findMany({
      where: { actor: ADMIN_SUB, action: 'ROOM_CREATE', target: created.id },
    });
    expect(createLogs).toHaveLength(1);

    await caller.admin.room.update({ id: created.id, name: 'Audit Test Updated' });
    const updateLogs = await prisma.auditLog.findMany({
      where: { actor: ADMIN_SUB, action: 'ROOM_UPDATE', target: created.id },
    });
    expect(updateLogs).toHaveLength(1);

    await caller.admin.room.delete({ id: created.id });
    const deleteLogs = await prisma.auditLog.findMany({
      where: { actor: ADMIN_SUB, action: 'ROOM_DELETE', target: created.id },
    });
    expect(deleteLogs).toHaveLength(1);
  });

  it('rejects a duplicate slug with BAD_REQUEST', async () => {
    const caller = await adminCaller();
    const slug = uniqueSlug('dup-slug');
    const first = await caller.admin.room.create({
      name: 'Dup Slug 1',
      slug,
      rateLimit: 1000,
      userMessageLimit: 3,
      accessPolicy: OPEN_POLICY,
    });
    createdRoomIds.push(first.id);

    await expect(
      caller.admin.room.create({
        name: 'Dup Slug 2',
        slug,
        rateLimit: 1000,
        userMessageLimit: 3,
        accessPolicy: OPEN_POLICY,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('allows userMessageLimit change on an empty room', async () => {
    const caller = await adminCaller();
    const created = await caller.admin.room.create({
      name: 'UML Empty',
      slug: uniqueSlug('uml-empty'),
      rateLimit: 1000,
      userMessageLimit: 3,
      accessPolicy: OPEN_POLICY,
    });
    createdRoomIds.push(created.id);

    const updated = await caller.admin.room.update({ id: created.id, userMessageLimit: 7 });
    expect(updated.userMessageLimit).toBe(7);
  });

  it('rejects userMessageLimit change on a room with members', async () => {
    const caller = await adminCaller();
    const created = await caller.admin.room.create({
      name: 'UML Members',
      slug: uniqueSlug('uml-members'),
      rateLimit: 1000,
      userMessageLimit: 3,
      accessPolicy: OPEN_POLICY,
    });
    createdRoomIds.push(created.id);

    await prisma.membership.create({
      data: { roomId: created.id, joinNullifier: `jn-uml-${randomUUID()}` },
    });

    await expect(
      caller.admin.room.update({ id: created.id, userMessageLimit: 9 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Same value is a no-op and must be allowed even with members.
    const noop = await caller.admin.room.update({ id: created.id, userMessageLimit: 3 });
    expect(noop.userMessageLimit).toBe(3);
  });
});

describe('room password hashing', () => {
  it('round-trips a correct password and encodes scrypt params', async () => {
    const stored = await hashRoomPassword('correct horse battery staple');
    expect(stored).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(await verifyRoomPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashRoomPassword('right-password');
    expect(await verifyRoomPassword('wrong-password', stored)).toBe(false);
  });

  it('returns false (does not throw) on a malformed stored hash', async () => {
    expect(await verifyRoomPassword('x', 'not-a-valid-hash')).toBe(false);
    expect(await verifyRoomPassword('x', 'scrypt$only$three')).toBe(false);
    expect(await verifyRoomPassword('x', 'scrypt$bad$8$1$dead$beef')).toBe(false);
  });

  it('verifies legacy-shorter hashes without a RangeError (length-mismatch guard)', async () => {
    // A stored hash whose digest length differs from the candidate digest must
    // return false rather than throwing inside timingSafeEqual.
    const stored = 'scrypt$1024$8$1$00112233445566778899aabbccddeeff$00ff';
    expect(await verifyRoomPassword('whatever', stored)).toBe(false);
  });
});
