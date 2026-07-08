import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, MembershipStatus, BanReason } from '@discreetly/db';
import { createLocalJWKSet } from 'jose';
import { appRouter } from '../trpc/app.router.js';
import { makeVerifier } from '../minister/verify.js';
import { makeProofCtx, proofFor } from '../test/rln-fixtures.js';
import { sendMessage } from '../messaging/pipeline.js';
import { joinRoom } from '../membership/membership.js';
import { jwks, signIdToken, MOCK_ISSUER, MOCK_CLIENT_ID } from '../test/mock-issuer.js';

const mockVerifier = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  jwks: createLocalJWKSet(await jwks()),
});

const ADMIN_SUB = `ban-author-admin-${randomUUID()}`;
const OPERATOR_SUBS: ReadonlySet<string> = new Set([ADMIN_SUB]);

const RATE_LIMIT = 1_000_000;
const AUTHOR_JN = `${Date.now()}1234567890`;
const ctx = makeProofCtx(90210n + BigInt(Date.now() % 100000), 2n);
const epoch = BigInt(Math.floor(Date.now() / RATE_LIMIT));
let roomId: string;

async function adminCaller() {
  const adminIdToken = await signIdToken({ sub: ADMIN_SUB });
  return appRouter.createCaller({ verify: mockVerifier, adminIdToken, operatorSubs: OPERATOR_SUBS });
}

beforeAll(async () => {
  const room = await prisma.room.create({
    data: {
      name: 'Ban Author Test',
      slug: `ban-author-${randomUUID()}`,
      rlnIdentifier: `${ctx.rlnIdentifier}`,
      rateLimit: RATE_LIMIT,
      userMessageLimit: 2,
      accessPolicy: { allOf: [] },
    },
  });
  roomId = room.id;
  await joinRoom({
    room: { ...room },
    joinNullifier: AUTHOR_JN,
    identityCommitment: ctx.identity.commitment.toString(),
  });
});

afterAll(async () => {
  await prisma.ban.deleteMany({ where: { roomId } });
  await prisma.auditLog.deleteMany({ where: { actor: ADMIN_SUB } });
  await prisma.message.deleteMany({ where: { roomId } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.$disconnect();
});

describe('sender join-nullifier on message.send (client-asserted author link)', () => {
  it('stores a jn matching an existing membership; drops an unknown one', async () => {
    // Linked: the sender's real membership jn.
    const p0 = await proofFor(ctx, 'linked', epoch, 0n);
    const r0 = await sendMessage({
      roomId,
      content: 'linked',
      proof: p0,
      joinNullifier: AUTHOR_JN,
    });
    expect(r0).toMatchObject({ status: 'sent' });

    // Unknown claim: valid bigint string, but no such membership → stored null.
    const p1 = await proofFor(ctx, 'unlinked', epoch, 1n);
    const r1 = await sendMessage({
      roomId,
      content: 'unlinked',
      proof: p1,
      joinNullifier: '99999999999999999999',
    });
    expect(r1).toMatchObject({ status: 'sent' });

    const linked = await prisma.message.findFirstOrThrow({ where: { roomId, content: 'linked' } });
    const unlinked = await prisma.message.findFirstOrThrow({
      where: { roomId, content: 'unlinked' },
    });
    expect(linked.senderJoinNullifier).toBe(AUTHOR_JN);
    expect(unlinked.senderJoinNullifier).toBeNull();
  });

  it('the author link is NOT exposed via public message.list output', async () => {
    const caller = appRouter.createCaller({ verify: mockVerifier });
    const listed = await caller.message.list({ roomId });
    expect(listed.length).toBeGreaterThan(0);
    for (const row of listed) {
      expect(row).not.toHaveProperty('senderJoinNullifier');
    }
  });
});

describe('admin.banMessageAuthor', () => {
  it('non-operator → FORBIDDEN', async () => {
    const msg = await prisma.message.findFirstOrThrow({ where: { roomId, content: 'linked' } });
    const token = await signIdToken({ sub: `rando-${randomUUID()}` });
    const caller = appRouter.createCaller({
      verify: mockVerifier,
      adminIdToken: token,
      operatorSubs: OPERATOR_SUBS,
    });
    await expect(caller.admin.banMessageAuthor({ messageId: msg.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('message without an author link → BAD_REQUEST', async () => {
    const msg = await prisma.message.findFirstOrThrow({ where: { roomId, content: 'unlinked' } });
    const caller = await adminCaller();
    await expect(caller.admin.banMessageAuthor({ messageId: msg.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('unknown message → NOT_FOUND', async () => {
    const caller = await adminCaller();
    await expect(caller.admin.banMessageAuthor({ messageId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('bans the linked author: membership BANNED, leaves pruned, Ban row, listed by admin.bans', async () => {
    const msg = await prisma.message.findFirstOrThrow({ where: { roomId, content: 'linked' } });
    const caller = await adminCaller();
    const res = await caller.admin.banMessageAuthor({ messageId: msg.id });
    expect(res).toMatchObject({ ok: true });

    const membership = await prisma.membership.findUniqueOrThrow({
      where: { roomId_joinNullifier: { roomId, joinNullifier: AUTHOR_JN } },
    });
    expect(membership.status).toBe(MembershipStatus.BANNED);

    const leaves = await prisma.membershipLeaf.count({ where: { membershipId: membership.id } });
    expect(leaves).toBe(0);

    const bans = await caller.admin.bans({ roomId });
    expect(bans.some((b) => b.joinNullifier === AUTHOR_JN && b.reason === BanReason.ADMIN)).toBe(
      true,
    );
    // The recovered-secret column is never disclosed to the operator UI.
    for (const b of bans) {
      expect(b).not.toHaveProperty('shamirSecret');
    }
  });
});
