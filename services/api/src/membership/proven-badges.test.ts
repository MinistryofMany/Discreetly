import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@discreetly/db';
import {
  loadProvenTypes,
  recordProvenTypes,
  userKeyForSub,
} from './proven-badges.js';

// Unique per-run subs so the suite is independent of existing rows.
const SUB_A = `pb-test-A-${Date.now()}`;
const SUB_B = `pb-test-B-${Date.now()}`;

afterAll(async () => {
  await prisma.provenBadge.deleteMany({
    where: { userKey: { in: [userKeyForSub(SUB_A), userKeyForSub(SUB_B)] } },
  });
  await prisma.$disconnect();
});

describe('proven-badges durable store', () => {
  it('records verified types and reads them back for the same sub', async () => {
    await recordProvenTypes(SUB_A, ['age-over-18', 'residency-country']);
    const types = await loadProvenTypes(SUB_A);
    expect([...types].sort()).toEqual(['age-over-18', 'residency-country']);
  });

  it('is idempotent: re-recording a type does not duplicate or move firstProvenAt', async () => {
    const key = userKeyForSub(SUB_A);
    const before = await prisma.provenBadge.findUnique({
      where: { userKey_badgeType: { userKey: key, badgeType: 'age-over-18' } },
    });
    expect(before).not.toBeNull();

    await recordProvenTypes(SUB_A, ['age-over-18']); // already proven
    const rows = await prisma.provenBadge.findMany({
      where: { userKey: key, badgeType: 'age-over-18' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.firstProvenAt.getTime()).toBe(before!.firstProvenAt.getTime());
  });

  it('adds only the new types on a later proof', async () => {
    await recordProvenTypes(SUB_A, ['age-over-18', 'invite-code']);
    const types = await loadProvenTypes(SUB_A);
    expect([...types].sort()).toEqual(['age-over-18', 'invite-code', 'residency-country']);
  });

  it('isolates proven sets across subs (a different sub reads an empty set)', async () => {
    const typesB = await loadProvenTypes(SUB_B);
    expect(typesB).toEqual([]);
    await recordProvenTypes(SUB_B, ['email-domain']);
    expect(await loadProvenTypes(SUB_B)).toEqual(['email-domain']);
    // SUB_A is unaffected.
    expect((await loadProvenTypes(SUB_A)).includes('email-domain')).toBe(false);
  });

  it('derives the user key from the pairwise sub (decimal field element)', () => {
    expect(userKeyForSub(SUB_A)).toMatch(/^[0-9]+$/);
    expect(userKeyForSub(SUB_A)).not.toBe(userKeyForSub(SUB_B));
  });
});
