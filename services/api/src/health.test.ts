import { describe, it, expect, afterAll } from 'vitest';
import { liveness, readiness } from './health.js';
import { prisma } from '@discreetly/db';
import { publisher } from './realtime/redis.js';

afterAll(async () => {
  await prisma.$disconnect();
  await publisher().quit();
});

describe('health', () => {
  it('liveness returns ok', () => {
    expect(liveness()).toEqual({ status: 'ok' });
  });

  it('readiness reports postgres + redis up when both reachable', async () => {
    const r = await readiness();
    expect(r.postgres).toBe(true);
    expect(r.redis).toBe(true);
    expect(r.ok).toBe(true);
  });
});
