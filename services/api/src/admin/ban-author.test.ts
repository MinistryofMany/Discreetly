import { randomUUID, randomBytes } from 'node:crypto';
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
// The sender's (public, derivable) join nullifier and a victim's, in the same
// room. The victim never sends anything; the forgery tests try to attribute
// the sender's messages to them.
const AUTHOR_JN = `${Date.now()}1234567890`;
const VICTIM_JN = `${Date.now()}9876543210`;
const ctx = makeProofCtx(90210n + BigInt(Date.now() % 100000), 5n);
const epoch = BigInt(Math.floor(Date.now() / RATE_LIMIT));
let roomId: string;
let otherRoomId: string;
/** The sender's own author-link secret, as returned by their join. */
let authorToken: string;
let authorMembershipId: string;
/** A perfectly valid token - but for a membership of a DIFFERENT room. */
let otherRoomToken: string;

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
      userMessageLimit: 5,
      accessPolicy: { allOf: [] },
    },
  });
  roomId = room.id;
  const joined = await joinRoom({
    room: { ...room },
    joinNullifier: AUTHOR_JN,
    identityCommitment: ctx.identity.commitment.toString(),
  });
  if (!joined.ok) throw new Error(`join failed: ${joined.reason}`);
  authorToken = joined.authorToken;
  authorMembershipId = joined.membershipId;

  // The victim: another member of the SAME room, with their own secret token.
  const victimJoin = await joinRoom({
    room: { ...room },
    joinNullifier: VICTIM_JN,
    identityCommitment: '123456789',
  });
  if (!victimJoin.ok) throw new Error(`victim join failed: ${victimJoin.reason}`);
  // The victim's leaf is part of the room's RLN tree now; the prover must
  // build the same tree as the server or every proof fails as bad-proof.
  ctx.leaves.push(BigInt(victimJoin.rateCommitment));

  // A second room with its own membership, to prove a real token cannot be
  // replayed across rooms.
  const otherRoom = await prisma.room.create({
    data: {
      name: 'Ban Author Other Room',
      slug: `ban-author-other-${randomUUID()}`,
      rlnIdentifier: `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`,
      rateLimit: RATE_LIMIT,
      userMessageLimit: 5,
      accessPolicy: { allOf: [] },
    },
  });
  otherRoomId = otherRoom.id;
  const otherJoin = await joinRoom({
    room: { ...otherRoom },
    joinNullifier: `${Date.now()}5555555555`,
    identityCommitment: '987654321',
  });
  if (!otherJoin.ok) throw new Error(`other-room join failed: ${otherJoin.reason}`);
  otherRoomToken = otherJoin.authorToken;
});

afterAll(async () => {
  await prisma.ban.deleteMany({ where: { roomId } });
  await prisma.auditLog.deleteMany({ where: { actor: ADMIN_SUB } });
  await prisma.message.deleteMany({ where: { roomId } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.room.delete({ where: { id: otherRoomId } });
  await prisma.$disconnect();
});

describe('membership.join issues the author-link secret', () => {
  it('returns a random 64-hex token, persisted uniquely on the membership row', async () => {
    expect(authorToken).toMatch(/^[0-9a-f]{64}$/);
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { id: authorMembershipId },
    });
    expect(membership.authorToken).toBe(authorToken);
    // Distinct memberships hold distinct secrets.
    expect(otherRoomToken).toMatch(/^[0-9a-f]{64}$/);
    expect(otherRoomToken).not.toBe(authorToken);
  });
});

describe('author token on message.send (moderation author link)', () => {
  it('stores the membershipId for the sender’s own token; drops an unknown one', async () => {
    // Linked: the sender's real secret.
    const p0 = await proofFor(ctx, 'linked', epoch, 0n);
    const r0 = await sendMessage({ roomId, content: 'linked', proof: p0, authorToken });
    expect(r0).toMatchObject({ status: 'sent' });

    // Guessed token: right shape, but no such membership -> stored null.
    const p1 = await proofFor(ctx, 'unlinked', epoch, 1n);
    const r1 = await sendMessage({
      roomId,
      content: 'unlinked',
      proof: p1,
      authorToken: randomBytes(32).toString('hex'),
    });
    expect(r1).toMatchObject({ status: 'sent' });

    const linked = await prisma.message.findFirstOrThrow({ where: { roomId, content: 'linked' } });
    const unlinked = await prisma.message.findFirstOrThrow({
      where: { roomId, content: 'unlinked' },
    });
    expect(linked.senderMembershipId).toBe(authorMembershipId);
    expect(unlinked.senderMembershipId).toBeNull();
  });

  it('a derivable value (a victim’s join nullifier) cannot attribute a message to them', async () => {
    // THE framing vector the token design kills: joinNullifier =
    // poseidon(sub, rlnIdentifier) is deterministic and rlnIdentifier is
    // public, so an attacker who knows a victim's pairwise sub can compute it.
    // Asserting it as the author link must NOT link the message to the victim
    // (or to anyone).
    const p = await proofFor(ctx, 'framed', epoch, 2n);
    const r = await sendMessage({ roomId, content: 'framed', proof: p, authorToken: VICTIM_JN });
    expect(r).toMatchObject({ status: 'sent' });

    const framed = await prisma.message.findFirstOrThrow({ where: { roomId, content: 'framed' } });
    expect(framed.senderMembershipId).toBeNull();

    // And the ban-author path fails closed on it instead of banning anyone.
    const caller = await adminCaller();
    await expect(caller.admin.banMessageAuthor({ messageId: framed.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const victim = await prisma.membership.findUniqueOrThrow({
      where: { roomId_joinNullifier: { roomId, joinNullifier: VICTIM_JN } },
    });
    expect(victim.status).toBe(MembershipStatus.ACTIVE);
    expect(await prisma.membershipLeaf.count({ where: { membershipId: victim.id } })).toBe(1);
  });

  it('a real token from ANOTHER room does not link (no cross-room replay)', async () => {
    const p = await proofFor(ctx, 'cross-room', epoch, 3n);
    const r = await sendMessage({
      roomId,
      content: 'cross-room',
      proof: p,
      authorToken: otherRoomToken,
    });
    expect(r).toMatchObject({ status: 'sent' });
    const crossed = await prisma.message.findFirstOrThrow({
      where: { roomId, content: 'cross-room' },
    });
    expect(crossed.senderMembershipId).toBeNull();
  });

  it('neither the author link nor the token is exposed via public message.list output', async () => {
    const caller = appRouter.createCaller({ verify: mockVerifier });
    const listed = await caller.message.list({ roomId });
    expect(listed.length).toBeGreaterThan(0);
    for (const row of listed) {
      expect(row).not.toHaveProperty('senderMembershipId');
      expect(row).not.toHaveProperty('authorToken');
    }
  });

  it('the token is not exposed via admin.room.memberships output', async () => {
    const caller = await adminCaller();
    const memberships = await caller.admin.room.memberships({ roomId });
    expect(memberships.length).toBeGreaterThan(0);
    for (const m of memberships) {
      expect(m).not.toHaveProperty('authorToken');
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

    // The victim (same room, never banned) is untouched by the whole suite.
    const victim = await prisma.membership.findUniqueOrThrow({
      where: { roomId_joinNullifier: { roomId, joinNullifier: VICTIM_JN } },
    });
    expect(victim.status).toBe(MembershipStatus.ACTIVE);
  });
});
