import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, MembershipStatus, BanReason } from '@discreetly/db';
import { createLocalJWKSet } from 'jose';
import { appRouter } from '../trpc/app.router.js';
import { makeVerifier } from '../minister/verify.js';
import { joinNullifier } from '../gate/join-nullifier.js';
import {
  jwks,
  signIdToken,
  MOCK_ISSUER,
  MOCK_CLIENT_ID,
} from '../test/mock-issuer.js';

const mockVerifier = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  jwks: createLocalJWKSet(await jwks()),
});

const ADMIN_SUB = `ban-admin-${randomUUID()}`;
let roomId: string;
let rlnIdentifier: string;

const OPERATOR_SUBS: ReadonlySet<string> = new Set([ADMIN_SUB]);

async function adminCaller() {
  const adminIdToken = await signIdToken({ sub: ADMIN_SUB });
  return appRouter.createCaller({ verify: mockVerifier, adminIdToken, operatorSubs: OPERATOR_SUBS });
}

beforeAll(async () => {
  const room = await prisma.room.create({
    data: {
      name: 'Ban Test',
      slug: `ban-${randomUUID()}`,
      // Numeric but unique across concurrent shared-DB runs.
      rlnIdentifier: `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`,
      rateLimit: 10_000,
      userMessageLimit: 5,
      maxDevices: 2,
      // Open policy so the join gate admits any verified identity.
      accessPolicy: { allOf: [] },
    },
  });
  roomId = room.id;
  rlnIdentifier = room.rlnIdentifier;
});

afterAll(async () => {
  await prisma.ban.deleteMany({ where: { roomId } });
  await prisma.auditLog.deleteMany({ where: { actor: ADMIN_SUB } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.$disconnect();
});

describe('admin ban management', () => {
  it('bans by identity commitment: membership BANNED, leaves pruned, Ban row, join rejected', async () => {
    const sub = `victim-ic-${randomUUID()}`;
    const jn = joinNullifier(sub, BigInt(rlnIdentifier)).toString();
    const identityCommitment = '424242';
    const idToken = await signIdToken({ sub });

    const joined = await appRouter
      .createCaller({ verify: mockVerifier })
      .membership.join({ roomId, idToken, identityCommitment });
    expect(joined).toMatchObject({ ok: true });

    const caller = await adminCaller();
    const result = await caller.admin.banByIdentityCommitment({
      roomId,
      identityCommitment,
    });
    expect(result).toMatchObject({ banned: true, joinNullifier: jn });

    const membership = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId, joinNullifier: jn } },
      include: { leaves: true },
    });
    expect(membership?.status).toBe(MembershipStatus.BANNED);
    expect(membership?.leaves).toHaveLength(0);

    const ban = await prisma.ban.findFirst({ where: { roomId, joinNullifier: jn } });
    expect(ban).toMatchObject({ reason: BanReason.ADMIN });

    const rejoin = await appRouter
      .createCaller({ verify: mockVerifier })
      .membership.join({ roomId, idToken, identityCommitment: '999999' });
    expect(rejoin).toMatchObject({ ok: false, reason: 'banned' });
  });

  it('bans by join-nullifier with no prior membership: creates BANNED membership, join rejected', async () => {
    const sub = `victim-jn-${randomUUID()}`;
    const jn = joinNullifier(sub, BigInt(rlnIdentifier)).toString();

    const before = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId, joinNullifier: jn } },
    });
    expect(before).toBeNull();

    const caller = await adminCaller();
    const result = await caller.admin.banByJoinNullifier({ roomId, joinNullifier: jn });
    expect(result).toMatchObject({ banned: true, joinNullifier: jn });

    const membership = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId, joinNullifier: jn } },
    });
    expect(membership?.status).toBe(MembershipStatus.BANNED);

    const idToken = await signIdToken({ sub });
    const join = await appRouter
      .createCaller({ verify: mockVerifier })
      .membership.join({ roomId, idToken, identityCommitment: '7' });
    expect(join).toMatchObject({ ok: false, reason: 'banned' });
  });

  it('unbans: membership ACTIVE, Ban rows gone, join succeeds again', async () => {
    const sub = `victim-unban-${randomUUID()}`;
    const jn = joinNullifier(sub, BigInt(rlnIdentifier)).toString();

    const caller = await adminCaller();
    await caller.admin.banByJoinNullifier({ roomId, joinNullifier: jn });

    const unban = await caller.admin.unban({ roomId, joinNullifier: jn });
    expect(unban).toEqual({ unbanned: true });

    const membership = await prisma.membership.findUnique({
      where: { roomId_joinNullifier: { roomId, joinNullifier: jn } },
    });
    expect(membership?.status).toBe(MembershipStatus.ACTIVE);

    const bans = await prisma.ban.findMany({ where: { roomId, joinNullifier: jn } });
    expect(bans).toHaveLength(0);

    const idToken = await signIdToken({ sub });
    const join = await appRouter
      .createCaller({ verify: mockVerifier })
      .membership.join({ roomId, idToken, identityCommitment: '12321' });
    expect(join).toMatchObject({ ok: true });
  });

  it('returns no-leaf when banning by IC with no matching leaf', async () => {
    const caller = await adminCaller();
    const result = await caller.admin.banByIdentityCommitment({
      roomId,
      identityCommitment: '8888888888',
    });
    expect(result).toEqual({ banned: false, reason: 'no-leaf' });
  });

  it('404 when banning by IC for a missing room', async () => {
    const caller = await adminCaller();
    await expect(
      caller.admin.banByIdentityCommitment({
        roomId: 'does-not-exist',
        identityCommitment: '1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('each op writes exactly one AuditLog row with the expected action + actor', async () => {
    const sub = `victim-audit-${randomUUID()}`;
    const jn = joinNullifier(sub, BigInt(rlnIdentifier)).toString();
    const identityCommitment = '5150';
    const idToken = await signIdToken({ sub });
    const caller = await adminCaller();

    await appRouter
      .createCaller({ verify: mockVerifier })
      .membership.join({ roomId, idToken, identityCommitment });

    await caller.admin.banByIdentityCommitment({ roomId, identityCommitment });
    const icLogs = await prisma.auditLog.findMany({
      where: {
        actor: ADMIN_SUB,
        action: 'ADMIN_BAN_IC',
        target: roomId,
        metadata: { path: ['joinNullifier'], equals: jn },
      },
    });
    expect(icLogs).toHaveLength(1);

    await caller.admin.unban({ roomId, joinNullifier: jn });
    const unbanLogs = await prisma.auditLog.findMany({
      where: {
        actor: ADMIN_SUB,
        action: 'ADMIN_UNBAN',
        target: roomId,
        metadata: { path: ['joinNullifier'], equals: jn },
      },
    });
    expect(unbanLogs).toHaveLength(1);

    const sub2 = `victim-audit2-${randomUUID()}`;
    const jn2 = joinNullifier(sub2, BigInt(rlnIdentifier)).toString();
    await caller.admin.banByJoinNullifier({ roomId, joinNullifier: jn2 });
    const jnLogs = await prisma.auditLog.findMany({
      where: {
        actor: ADMIN_SUB,
        action: 'ADMIN_BAN_NULLIFIER',
        target: roomId,
        metadata: { path: ['joinNullifier'], equals: jn2 },
      },
    });
    expect(jnLogs).toHaveLength(1);
  });
});
