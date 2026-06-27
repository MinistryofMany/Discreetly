/**
 * Durable proven-badge store (fork F-D model). Records only that a Discreetly
 * user (anchored on the pairwise `sub`) proved a badge TYPE at least once - no
 * VC, no attribute values, no VC `iat`. It is the source of truth for "already
 * proven", letting a later room request only genuinely-new badge types.
 *
 * Non-forgeable by construction: every key is `userKeyForSub(verifiedSub)`,
 * derived from a verified id_token's `sub` (never client input), so one user's
 * proven set can never satisfy another user's join.
 *
 * SECURITY (F-D): because this store carries no attributes and no issued-at, it
 * may ONLY satisfy bare type-only policy leaves. A constrained leaf
 * (`where`/`maxAgeDays`) must always re-request the live badge; the gate never
 * synthesizes a durable-proven badge for a constrained leaf. See `gate.ts`.
 */
import { prisma } from '@discreetly/db';
import { toField } from '../gate/join-nullifier.js';

/**
 * A minimal Prisma client surface (the base client or an interactive-transaction
 * client) so the write can share the join transaction.
 */
type ProvenBadgeClient = {
  provenBadge: {
    findMany: typeof prisma.provenBadge.findMany;
    upsert: typeof prisma.provenBadge.upsert;
  };
};

/**
 * Discreetly-scoped user key: `toField(pairwise sub)` as a decimal string, the
 * same reduction `joinNullifier` uses. The raw Minister sub never lands in this
 * table; the pairwise sub is already RP-scoped.
 */
export function userKeyForSub(sub: string): string {
  return toField(sub).toString();
}

/** Badge types this user has durably proven, for the given verified `sub`. */
export async function loadProvenTypes(sub: string): Promise<string[]> {
  const userKey = userKeyForSub(sub);
  const rows = await prisma.provenBadge.findMany({
    where: { userKey },
    select: { badgeType: true },
  });
  return rows.map((r) => r.badgeType);
}

/**
 * Record (idempotent upsert) that this user proved each of `badgeTypes`. Keyed
 * on the verified `sub`; the `@@unique([userKey, badgeType])` constraint makes
 * re-recording a no-op. Pass `client` to enlist in an outer transaction so a
 * failed join leaves no orphan write.
 */
export async function recordProvenTypes(
  sub: string,
  badgeTypes: readonly string[],
  client: ProvenBadgeClient = prisma,
): Promise<void> {
  const userKey = userKeyForSub(sub);
  for (const badgeType of new Set(badgeTypes)) {
    await client.provenBadge.upsert({
      where: { userKey_badgeType: { userKey, badgeType } },
      create: { userKey, badgeType },
      // Touch nothing on conflict: `firstProvenAt` must stay the first proof.
      update: {},
    });
  }
}
