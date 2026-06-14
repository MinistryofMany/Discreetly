import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@discreetly/db';
import { createLocalJWKSet } from 'jose';
import { appRouter } from './app.router.js';
import { makeVerifier } from '../minister/verify.js';
import { jwks, signIdToken, MOCK_ISSUER, MOCK_VC_ISSUER, MOCK_CLIENT_ID } from '../test/mock-issuer.js';

const verify = makeVerifier({
  issuer: MOCK_ISSUER, audience: MOCK_CLIENT_ID, vcIssuer: MOCK_VC_ISSUER,
  jwks: createLocalJWKSet(await jwks()),
});

let roomId: string;

beforeAll(async () => {
  const r = await prisma.room.create({
    data: {
      name: 'Router Test', slug: `rt-${Date.now()}`,
      // rlnIdentifier MUST be numeric — the router does BigInt(room.rlnIdentifier)
      rlnIdentifier: String(Date.now()),
      rateLimit: 10_000, userMessageLimit: 5,
      accessPolicy: { badge: { type: 'email-domain', where: { domain: 'acme.com' } } },
    },
  });
  roomId = r.id;
});
afterAll(async () => {
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.$disconnect();
});

describe('membership.join via tRPC', () => {
  it('admits a user whose badge satisfies the room policy', async () => {
    const caller = appRouter.createCaller({ verify });
    const idToken = await signIdToken({ sub: 'router-sub', badges: [{ type: 'email-domain', attributes: { domain: 'acme.com' } }] });
    const res = await caller.membership.join({ roomId, idToken, identityCommitment: '12345', deviceLabel: 'phone' });
    expect(res.ok).toBe(true);
    const leaves = await caller.room.leaves({ id: roomId });
    expect(leaves.length).toBe(1);
  });

  it('rejects a user missing the required badge', async () => {
    const caller = appRouter.createCaller({ verify });
    const idToken = await signIdToken({ sub: 'router-sub-2', badges: [{ type: 'invite-code', attributes: { label: 'x' } }] });
    const res = await caller.membership.join({ roomId, idToken, identityCommitment: '999' });
    expect(res).toMatchObject({ ok: false, reason: 'policy-denied' });
  });
});
