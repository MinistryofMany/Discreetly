import { describe, it, expect } from 'vitest';
import { createLocalJWKSet } from 'jose';
import { appRouter } from '../trpc/app.router.js';
import { makeVerifier } from '../minister/verify.js';
import {
  jwks,
  signIdToken,
  MOCK_ISSUER,
  MOCK_CLIENT_ID,
} from '../test/mock-issuer.js';
import { parseOperatorSubs } from '../config.js';

const mockVerifier = makeVerifier({
  issuer: MOCK_ISSUER,
  audience: MOCK_CLIENT_ID,
  jwks: createLocalJWKSet(await jwks()),
});

const ADMIN_SUB = `admin-sub-${Date.now()}`;
const OPERATOR_SUBS: ReadonlySet<string> = new Set([ADMIN_SUB]);

describe('admin auth (adminProcedure / whoami, env-allowlist gate)', () => {
  it('no Authorization header → UNAUTHORIZED', async () => {
    const caller = appRouter.createCaller({ verify: mockVerifier, operatorSubs: OPERATOR_SUBS });
    await expect(caller.admin.whoami()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'admin auth required',
    });
  });

  it('invalid id_token → UNAUTHORIZED (invalid, not expired)', async () => {
    const caller = appRouter.createCaller({
      verify: mockVerifier,
      adminIdToken: 'not-a-jwt',
      operatorSubs: OPERATOR_SUBS,
    });
    await expect(caller.admin.whoami()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'invalid admin id_token',
    });
  });

  it('expired id_token → UNAUTHORIZED with the distinct expired message', async () => {
    // Expired an hour ago; signature/issuer/audience otherwise valid.
    const token = await signIdToken({ sub: ADMIN_SUB, expiresInSeconds: -3600 });
    const caller = appRouter.createCaller({
      verify: mockVerifier,
      adminIdToken: token,
      operatorSubs: OPERATOR_SUBS,
    });
    await expect(caller.admin.whoami()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'admin id_token expired',
    });
  });

  it('valid token, sub not in allowlist → FORBIDDEN', async () => {
    const token = await signIdToken({ sub: `not-admin-${Date.now()}` });
    const caller = appRouter.createCaller({
      verify: mockVerifier,
      adminIdToken: token,
      operatorSubs: OPERATOR_SUBS,
    });
    await expect(caller.admin.whoami()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'not an operator',
    });
  });

  it('fails CLOSED: empty allowlist rejects even a would-be operator', async () => {
    const token = await signIdToken({ sub: ADMIN_SUB });
    const caller = appRouter.createCaller({
      verify: mockVerifier,
      adminIdToken: token,
      operatorSubs: new Set<string>(),
    });
    await expect(caller.admin.whoami()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('fails CLOSED: missing allowlist (context without operatorSubs) rejects', async () => {
    const token = await signIdToken({ sub: ADMIN_SUB });
    const caller = appRouter.createCaller({ verify: mockVerifier, adminIdToken: token });
    await expect(caller.admin.whoami()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('valid allowlisted token → whoami returns the sub', async () => {
    const token = await signIdToken({ sub: ADMIN_SUB });
    const caller = appRouter.createCaller({
      verify: mockVerifier,
      adminIdToken: token,
      operatorSubs: OPERATOR_SUBS,
    });
    const result = await caller.admin.whoami();
    expect(result).toEqual({ adminSub: ADMIN_SUB });
  });
});

describe('parseOperatorSubs', () => {
  it('parses a comma-separated list with whitespace', () => {
    const set = parseOperatorSubs(' sub-a , sub-b,sub-c ');
    expect([...set].sort()).toEqual(['sub-a', 'sub-b', 'sub-c']);
  });

  it('empty / whitespace / bare commas parse to an EMPTY set (fail closed)', () => {
    expect(parseOperatorSubs('').size).toBe(0);
    expect(parseOperatorSubs('   ').size).toBe(0);
    expect(parseOperatorSubs(',,,').size).toBe(0);
  });

  it('never admits the empty string', () => {
    expect(parseOperatorSubs(',').has('')).toBe(false);
  });
});
