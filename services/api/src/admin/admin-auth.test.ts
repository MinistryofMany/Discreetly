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

const mockVerifier = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  vcIssuer: MOCK_VC_ISSUER,
  jwks: createLocalJWKSet(await jwks()),
});

const ADMIN_SUB = `admin-sub-${Date.now()}`;

beforeAll(async () => {
  await prisma.adminUser.create({ data: { pairwiseSub: ADMIN_SUB, label: 'test admin' } });
});

afterAll(async () => {
  await prisma.adminUser.deleteMany({ where: { pairwiseSub: ADMIN_SUB } });
  await prisma.$disconnect();
});

describe('admin auth (adminProcedure / whoami)', () => {
  it('no Authorization header → UNAUTHORIZED', async () => {
    const caller = appRouter.createCaller({ verify: mockVerifier });
    await expect(caller.admin.whoami()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('invalid id_token → UNAUTHORIZED', async () => {
    const caller = appRouter.createCaller({
      verify: mockVerifier,
      adminIdToken: 'not-a-jwt',
    });
    await expect(caller.admin.whoami()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('valid non-admin token → FORBIDDEN', async () => {
    const token = await signIdToken({ sub: `not-admin-${Date.now()}` });
    const caller = appRouter.createCaller({ verify: mockVerifier, adminIdToken: token });
    await expect(caller.admin.whoami()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('valid admin token → whoami returns the sub', async () => {
    const token = await signIdToken({ sub: ADMIN_SUB });
    const caller = appRouter.createCaller({ verify: mockVerifier, adminIdToken: token });
    const result = await caller.admin.whoami();
    expect(result).toEqual({ adminSub: ADMIN_SUB });
  });
});
