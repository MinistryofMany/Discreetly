import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@discreetly/db';
import { createLocalJWKSet } from 'jose';
import { appRouter } from '../trpc/app.router.js';
import { makeVerifier } from '../minister/verify.js';
import { roomMessages, type RoomBroadcast } from '../realtime/broadcast.js';
import {
  jwks,
  signIdToken,
  MOCK_ISSUER,
  MOCK_VC_ISSUER,
  MOCK_CLIENT_ID,
} from '../test/mock-issuer.js';

const mockVerifier = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  vcIssuer: MOCK_VC_ISSUER,
  jwks: createLocalJWKSet(await jwks()),
});

const ADMIN_SUB = `inspection-admin-${Date.now()}`;
let roomId: string;
let membershipJoinNullifier: string;

async function adminCaller() {
  const adminIdToken = await signIdToken({ sub: ADMIN_SUB });
  return appRouter.createCaller({ verify: mockVerifier, adminIdToken });
}

beforeAll(async () => {
  await prisma.adminUser.create({ data: { pairwiseSub: ADMIN_SUB, label: 'inspection test admin' } });

  const room = await prisma.room.create({
    data: {
      name: 'Inspection Test Room',
      slug: `inspection-${Date.now()}`,
      rlnIdentifier: `${Date.now() + 99}`,
      rateLimit: 10_000,
      userMessageLimit: 5,
      accessPolicy: { allOf: [] },
    },
  });
  roomId = room.id;

  membershipJoinNullifier = `jn-inspect-${Date.now()}`;
  const membership = await prisma.membership.create({
    data: {
      roomId,
      joinNullifier: membershipJoinNullifier,
    },
  });

  await prisma.membershipLeaf.create({
    data: {
      membershipId: membership.id,
      roomId,
      identityCommitment: '111222333',
      rateCommitment: '444555666',
      deviceLabel: 'phone',
    },
  });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { actor: ADMIN_SUB } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.adminUser.deleteMany({ where: { pairwiseSub: ADMIN_SUB } });
  await prisma.$disconnect();
});

describe('admin inspection', () => {
  describe('room.memberships', () => {
    it('returns memberships with non-revoked leaves', async () => {
      const caller = await adminCaller();
      const result = await caller.admin.room.memberships({ roomId });

      expect(result).toHaveLength(1);
      const mem = result[0]!;
      expect(mem.joinNullifier).toBe(membershipJoinNullifier);
      expect(mem.status).toBe('ACTIVE');
      expect(mem.createdAt).toBeInstanceOf(Date);
      expect(mem.leaves).toHaveLength(1);

      const leaf = mem.leaves[0]!;
      expect(leaf.identityCommitment).toBe('111222333');
      expect(leaf.rateCommitment).toBe('444555666');
      expect(leaf.deviceLabel).toBe('phone');
      expect(leaf.createdAt).toBeInstanceOf(Date);
    });

    it('excludes revoked leaves', async () => {
      const caller = await adminCaller();

      // Create a second membership with a revoked leaf
      const revokedJn = `jn-revoked-${Date.now()}`;
      const mem2 = await prisma.membership.create({
        data: { roomId, joinNullifier: revokedJn },
      });
      await prisma.membershipLeaf.create({
        data: {
          membershipId: mem2.id,
          roomId,
          identityCommitment: '777888999',
          rateCommitment: '112233445',
          deviceLabel: 'tablet',
          revokedAt: new Date(),
        },
      });

      const result = await caller.admin.room.memberships({ roomId });
      const found = result.find((m) => m.joinNullifier === revokedJn);
      expect(found).toBeDefined();
      // Revoked leaf must not appear
      expect(found!.leaves).toHaveLength(0);

      // Cleanup
      await prisma.membership.delete({ where: { id: mem2.id } });
    });

    it('returns 404 for a missing room', async () => {
      const caller = await adminCaller();
      await expect(
        caller.admin.room.memberships({ roomId: 'does-not-exist' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('auditLog', () => {
    it('filters by roomId (target)', async () => {
      const caller = await adminCaller();
      // Generate a known audit row by broadcasting
      await caller.admin.broadcast({ roomId, text: 'audit-filter-test' });

      const logs = await caller.admin.auditLog({ roomId });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      for (const log of logs) {
        expect(log.target).toBe(roomId);
      }
    });

    it('filters by action', async () => {
      const caller = await adminCaller();
      await caller.admin.broadcast({ roomId, text: 'action-filter' });

      const logs = await caller.admin.auditLog({ action: 'SYSTEM_BROADCAST' });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      for (const log of logs) {
        expect(log.action).toBe('SYSTEM_BROADCAST');
      }
    });

    it('filters by actor', async () => {
      const caller = await adminCaller();
      const logs = await caller.admin.auditLog({ actor: ADMIN_SUB });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      for (const log of logs) {
        expect(log.actor).toBe(ADMIN_SUB);
      }
    });

    it('returns newest first', async () => {
      const caller = await adminCaller();
      const logs = await caller.admin.auditLog({ actor: ADMIN_SUB });
      for (let i = 1; i < logs.length; i++) {
        expect(logs[i - 1]!.createdAt >= logs[i]!.createdAt).toBe(true);
      }
    });

    it('respects the limit cap', async () => {
      const caller = await adminCaller();

      // Insert enough rows to exceed limit=1
      await caller.admin.broadcast({ roomId, text: 'cap-test-1' });
      await caller.admin.broadcast({ roomId, text: 'cap-test-2' });

      const limited = await caller.admin.auditLog({ actor: ADMIN_SUB, limit: 1 });
      expect(limited).toHaveLength(1);
    });

    it('rejects limit above 500', async () => {
      const caller = await adminCaller();
      await expect(
        caller.admin.auditLog({ limit: 501 }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('broadcast', () => {
    it('sends a system message that a roomMessages subscriber receives', async () => {
      const ac = new AbortController();
      const received: RoomBroadcast[] = [];

      const gen = roomMessages(roomId, ac.signal);
      const collecting = (async () => {
        for await (const msg of gen) received.push(msg);
      })();

      // Wait for Redis subscriber to attach
      await new Promise((r) => setTimeout(r, 200));

      const caller = await adminCaller();
      await caller.admin.broadcast({ roomId, text: 'hello from admin' });

      await new Promise((r) => setTimeout(r, 200));

      ac.abort();
      await collecting;

      expect(received).toHaveLength(1);
      const msg = received[0]!;
      expect(msg.kind).toBe('system');
      if (msg.kind === 'system') {
        expect(msg.text).toBe('hello from admin');
        expect(msg.roomId).toBe(roomId);
      }
    });

    it('writes an AuditLog row with action SYSTEM_BROADCAST', async () => {
      const caller = await adminCaller();
      const text = `broadcast-audit-${Date.now()}`;
      await caller.admin.broadcast({ roomId, text });

      const logs = await prisma.auditLog.findMany({
        where: {
          actor: ADMIN_SUB,
          action: 'SYSTEM_BROADCAST',
          target: roomId,
          metadata: { path: ['text'], equals: text },
        },
      });
      expect(logs).toHaveLength(1);
    });

    it('returns { ok: true }', async () => {
      const caller = await adminCaller();
      const result = await caller.admin.broadcast({ roomId, text: 'ok-check' });
      expect(result).toEqual({ ok: true });
    });

    it('returns 404 for a missing room', async () => {
      const caller = await adminCaller();
      await expect(
        caller.admin.broadcast({ roomId: 'does-not-exist', text: 'nope' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
