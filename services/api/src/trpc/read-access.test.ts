import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@discreetly/db';
import { createLocalJWKSet } from 'jose';
import { appRouter } from './app.router.js';
import { makeVerifier } from '../minister/verify.js';
import {
  jwks,
  signIdToken,
  MOCK_ISSUER,
  MOCK_CLIENT_ID,
} from '../test/mock-issuer.js';
import { joinNullifier } from '../gate/join-nullifier.js';
import { joinRoom } from '../membership/membership.js';

const mockVerifier = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  jwks: createLocalJWKSet(await jwks()),
});

const caller = appRouter.createCaller({ verify: mockVerifier });

const TS = Date.now();
const RLN_PRIVATE = String(TS);
const RLN_PUBLIC = String(TS + 1);

let publicRoomId: string;
let privateRoomId: string;

beforeAll(async () => {
  const pub = await prisma.room.create({
    data: {
      name: 'Public Read Test',
      slug: `pub-read-${TS}`,
      rlnIdentifier: RLN_PUBLIC,
      rateLimit: 10_000,
      userMessageLimit: 5,
      visibility: 'PUBLIC',
      accessPolicy: {},
    },
  });
  publicRoomId = pub.id;

  const priv = await prisma.room.create({
    data: {
      name: 'Private Read Test',
      slug: `priv-read-${TS}`,
      rlnIdentifier: RLN_PRIVATE,
      rateLimit: 10_000,
      userMessageLimit: 5,
      visibility: 'PRIVATE',
      accessPolicy: {},
    },
  });
  privateRoomId = priv.id;
});

afterAll(async () => {
  await prisma.room.delete({ where: { id: privateRoomId } });
  await prisma.room.delete({ where: { id: publicRoomId } });
  await prisma.$disconnect();
});

describe('read access control', () => {
  it('PUBLIC room: room.leaves works with no idToken', async () => {
    const leaves = await caller.room.leaves({ id: publicRoomId });
    expect(Array.isArray(leaves)).toBe(true);
  });

  it('PRIVATE room, no idToken → UNAUTHORIZED', async () => {
    await expect(caller.room.leaves({ id: privateRoomId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('PRIVATE room, valid idToken of a non-member → FORBIDDEN', async () => {
    const nonMemberToken = await signIdToken({ sub: 'non-member-sub' });
    await expect(
      caller.room.leaves({ id: privateRoomId, idToken: nonMemberToken }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('PRIVATE room, valid idToken of ACTIVE member → allowed (leaves returns)', async () => {
    const memberSub = 'active-member-sub';
    const rlnId = BigInt(RLN_PRIVATE);
    const jn = joinNullifier(memberSub, rlnId).toString();

    // Seat the membership directly (bypassing gate policy check since the room policy is empty)
    const room = await prisma.room.findUniqueOrThrow({
      where: { id: privateRoomId },
      select: { id: true, rlnIdentifier: true, userMessageLimit: true, maxDevices: true },
    });
    await joinRoom({ room, joinNullifier: jn, identityCommitment: '99999' });

    const memberToken = await signIdToken({ sub: memberSub });
    const leaves = await caller.room.leaves({ id: privateRoomId, idToken: memberToken });
    expect(Array.isArray(leaves)).toBe(true);
    expect(leaves.length).toBeGreaterThanOrEqual(1);
  });

  it('PUBLIC room: room.get works with no idToken and omits passwordHash', async () => {
    const room = await caller.room.get({ id: publicRoomId });
    expect(room?.id).toBe(publicRoomId);
    expect(room).not.toHaveProperty('passwordHash');
  });

  it('PRIVATE room: room.get with no idToken → UNAUTHORIZED', async () => {
    await expect(caller.room.get({ id: privateRoomId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('PRIVATE room: room.get for an ACTIVE member returns the room (no passwordHash)', async () => {
    const sub = 'get-member-sub';
    const jn = joinNullifier(sub, BigInt(RLN_PRIVATE)).toString();
    const room = await prisma.room.findUniqueOrThrow({
      where: { id: privateRoomId },
      select: { id: true, rlnIdentifier: true, userMessageLimit: true, maxDevices: true },
    });
    await joinRoom({ room, joinNullifier: jn, identityCommitment: '88888' });
    const token = await signIdToken({ sub });
    const got = await caller.room.get({ id: privateRoomId, idToken: token });
    expect(got?.id).toBe(privateRoomId);
    expect(got).not.toHaveProperty('passwordHash');
  });
});
