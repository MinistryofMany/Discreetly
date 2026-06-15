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

let publicRoomId: string;
let privateRoomId: string;
let ephemeralRoomId: string;
const PRIVATE_RLN = String(TS + 11);

beforeAll(async () => {
  const pub = await prisma.room.create({
    data: {
      name: 'List Public',
      slug: `list-pub-${TS}`,
      rlnIdentifier: String(TS + 10),
      rateLimit: 10_000,
      userMessageLimit: 5,
      visibility: 'PUBLIC',
      persistence: 'PERSISTENT',
      accessPolicy: {},
    },
  });
  publicRoomId = pub.id;

  const priv = await prisma.room.create({
    data: {
      name: 'List Private',
      slug: `list-priv-${TS}`,
      rlnIdentifier: PRIVATE_RLN,
      rateLimit: 10_000,
      userMessageLimit: 5,
      visibility: 'PRIVATE',
      persistence: 'PERSISTENT',
      accessPolicy: {},
    },
  });
  privateRoomId = priv.id;

  const eph = await prisma.room.create({
    data: {
      name: 'List Ephemeral',
      slug: `list-eph-${TS}`,
      rlnIdentifier: String(TS + 12),
      rateLimit: 10_000,
      userMessageLimit: 5,
      visibility: 'PUBLIC',
      persistence: 'EPHEMERAL',
      accessPolicy: {},
    },
  });
  ephemeralRoomId = eph.id;

  // Seed three persisted messages in the public room.
  for (let i = 0; i < 3; i++) {
    await prisma.message.create({
      data: {
        roomId: publicRoomId,
        epoch: BigInt(i + 1),
        rlnNullifier: `nf-${TS}-${i}`,
        content: `msg-${i}`,
        proof: {},
        sessionColor: '#abcdef',
      },
    });
  }

  // Seed a message in the ephemeral room (should still not be returned by list).
  await prisma.message.create({
    data: {
      roomId: ephemeralRoomId,
      epoch: BigInt(1),
      rlnNullifier: `eph-nf-${TS}`,
      content: 'ephemeral-msg',
      proof: {},
    },
  });
});

afterAll(async () => {
  await prisma.message.deleteMany({
    where: { roomId: { in: [publicRoomId, privateRoomId, ephemeralRoomId] } },
  });
  await prisma.room.delete({ where: { id: ephemeralRoomId } });
  await prisma.room.delete({ where: { id: privateRoomId } });
  await prisma.room.delete({ where: { id: publicRoomId } });
  await prisma.$disconnect();
});

describe('message.list', () => {
  it('returns persisted messages newest-first in ChatBroadcast shape', async () => {
    const msgs = await caller.message.list({ roomId: publicRoomId });
    expect(msgs.length).toBe(3);
    // newest-first: epoch 3 then 2 then 1
    expect(msgs.map((m) => m.content)).toEqual(['msg-2', 'msg-1', 'msg-0']);
    const first = msgs[0]!;
    expect(first.kind).toBe('message');
    expect(typeof first.id).toBe('string');
    expect(first.roomId).toBe(publicRoomId);
    expect(typeof first.epoch).toBe('string');
    expect(typeof first.createdAt).toBe('string');
    expect(first.sessionColor).toBe('#abcdef');
  });

  it('honors the limit (and its max)', async () => {
    const msgs = await caller.message.list({ roomId: publicRoomId, limit: 2 });
    expect(msgs.length).toBe(2);
    await expect(
      caller.message.list({ roomId: publicRoomId, limit: 999 }),
    ).rejects.toThrow();
  });

  it('returns [] for an EPHEMERAL room even with persisted rows', async () => {
    const msgs = await caller.message.list({ roomId: ephemeralRoomId });
    expect(msgs).toEqual([]);
  });

  it('NOT_FOUND for an unknown room', async () => {
    await expect(caller.message.list({ roomId: 'does-not-exist' })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });

  it('PRIVATE room, no idToken -> UNAUTHORIZED', async () => {
    await expect(caller.message.list({ roomId: privateRoomId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('PRIVATE room, non-member token -> FORBIDDEN', async () => {
    const token = await signIdToken({ sub: `list-nonmember-${TS}` });
    await expect(
      caller.message.list({ roomId: privateRoomId, idToken: token }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('PRIVATE room, ACTIVE member token -> allowed', async () => {
    const sub = `list-member-${TS}`;
    const jn = joinNullifier(sub, BigInt(PRIVATE_RLN)).toString();
    const room = await prisma.room.findUniqueOrThrow({
      where: { id: privateRoomId },
      select: { id: true, rlnIdentifier: true, userMessageLimit: true, maxDevices: true },
    });
    await joinRoom({ room, joinNullifier: jn, identityCommitment: `77777${TS}` });
    const token = await signIdToken({ sub });
    const msgs = await caller.message.list({ roomId: privateRoomId, idToken: token });
    expect(Array.isArray(msgs)).toBe(true);
  });
});
