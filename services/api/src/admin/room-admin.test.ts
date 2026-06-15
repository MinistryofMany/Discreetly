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

const mockVerifier = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  vcIssuer: MOCK_VC_ISSUER,
  jwks: createLocalJWKSet(await jwks()),
});

const ADMIN_SUB = `room-admin-${Date.now()}`;
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
    const slug = `open-room-${Date.now()}`;
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
    const slug = `aes-room-${Date.now()}`;
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
      slug: `unique-1-${Date.now()}`,
      rateLimit: 1000,
      userMessageLimit: 3,
      accessPolicy: OPEN_POLICY,
    });
    const r2 = await caller.admin.room.create({
      name: 'Unique Test 2',
      slug: `unique-2-${Date.now()}`,
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
        slug: `bad-policy-${Date.now()}`,
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
        slug: `aes-no-pw-${Date.now()}`,
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
      slug: `update-test-${Date.now()}`,
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
      slug: `update-policy-${Date.now()}`,
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
      slug: `delete-test-${Date.now()}`,
      rateLimit: 1000,
      userMessageLimit: 3,
      accessPolicy: OPEN_POLICY,
    });

    // Seed a membership so we can verify cascade
    const membership = await prisma.membership.create({
      data: {
        roomId: created.id,
        joinNullifier: `jn-del-${Date.now()}`,
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
    const slug = `private-room-${Date.now()}`;
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
    const slug = `get-test-${Date.now()}`;
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
    const slug = `audit-test-${Date.now()}`;
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
});
