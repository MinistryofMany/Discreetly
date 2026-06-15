import { prisma, BanReason, MembershipStatus } from '@discreetly/db';
import { getRateCommitmentHash } from '@discreetly/crypto';
import { audit } from './audit.js';

export type AdminBanOutcome =
  | { banned: true; joinNullifier: string; prunedLeaves: number }
  | { banned: false; reason: 'no-leaf' };

export interface BanByJoinNullifierInput {
  roomId: string;
  joinNullifier: string;
  actor: string;
}

/**
 * Ban a membership by its join-nullifier.
 *
 * Upserts the Membership to BANNED on BOTH create and update: a join-nullifier
 * that has never joined must still be blocked, because the join path rejects on
 * `Membership.status === BANNED` (not on the `Ban` table). Prunes all of the
 * membership's leaves so the identity is removed from the tree.
 */
export async function banByJoinNullifier(
  input: BanByJoinNullifierInput,
): Promise<{ banned: true; joinNullifier: string; prunedLeaves: number }> {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.upsert({
      where: {
        roomId_joinNullifier: { roomId: input.roomId, joinNullifier: input.joinNullifier },
      },
      create: {
        roomId: input.roomId,
        joinNullifier: input.joinNullifier,
        status: MembershipStatus.BANNED,
      },
      update: { status: MembershipStatus.BANNED },
      select: { id: true, joinNullifier: true },
    });
    const pruned = await tx.membershipLeaf.deleteMany({
      where: { membershipId: membership.id },
    });
    await tx.ban.create({
      data: {
        roomId: input.roomId,
        joinNullifier: membership.joinNullifier,
        reason: BanReason.ADMIN,
      },
    });
    await audit(
      {
        actor: input.actor,
        action: 'ADMIN_BAN_NULLIFIER',
        target: input.roomId,
        metadata: { joinNullifier: membership.joinNullifier },
      },
      tx,
    );
    return {
      banned: true as const,
      joinNullifier: membership.joinNullifier,
      prunedLeaves: pruned.count,
    };
  });
}

export interface BanByIdentityCommitmentInput {
  roomId: string;
  identityCommitment: string;
  userMessageLimit: number;
  actor: string;
}

/**
 * Ban by identity commitment: resolve the device leaf via its rate commitment,
 * ban the owning membership, and prune all of its leaves. Returns `no-leaf` if
 * no leaf with that rate commitment exists in the room.
 */
export async function banByIdentityCommitment(
  input: BanByIdentityCommitmentInput,
): Promise<AdminBanOutcome> {
  const rateCommitment = getRateCommitmentHash(
    BigInt(input.identityCommitment),
    input.userMessageLimit,
  ).toString();

  return prisma.$transaction(async (tx) => {
    const leaf = await tx.membershipLeaf.findUnique({
      where: { roomId_rateCommitment: { roomId: input.roomId, rateCommitment } },
      select: { membershipId: true },
    });
    if (!leaf) return { banned: false as const, reason: 'no-leaf' as const };

    const membership = await tx.membership.update({
      where: { id: leaf.membershipId },
      data: { status: MembershipStatus.BANNED },
      select: { joinNullifier: true },
    });
    const pruned = await tx.membershipLeaf.deleteMany({
      where: { membershipId: leaf.membershipId },
    });
    await tx.ban.create({
      data: {
        roomId: input.roomId,
        joinNullifier: membership.joinNullifier,
        rateCommitment,
        reason: BanReason.ADMIN,
      },
    });
    await audit(
      {
        actor: input.actor,
        action: 'ADMIN_BAN_IC',
        target: input.roomId,
        metadata: { joinNullifier: membership.joinNullifier, rateCommitment },
      },
      tx,
    );
    return {
      banned: true as const,
      joinNullifier: membership.joinNullifier,
      prunedLeaves: pruned.count,
    };
  });
}

export interface UnbanInput {
  roomId: string;
  joinNullifier: string;
  actor: string;
}

/**
 * Lift a ban: set the membership back to ACTIVE (if present) and clear its Ban
 * rows. Note: leaves were pruned at ban time, so the user must re-join (or
 * rotate) to obtain a device leaf again; this only re-opens the join path.
 */
export async function unban(input: UnbanInput): Promise<{ unbanned: true }> {
  return prisma.$transaction(async (tx) => {
    await tx.membership.updateMany({
      where: { roomId: input.roomId, joinNullifier: input.joinNullifier },
      data: { status: MembershipStatus.ACTIVE },
    });
    await tx.ban.deleteMany({
      where: { roomId: input.roomId, joinNullifier: input.joinNullifier },
    });
    await audit(
      {
        actor: input.actor,
        action: 'ADMIN_UNBAN',
        target: input.roomId,
        metadata: { joinNullifier: input.joinNullifier },
      },
      tx,
    );
    return { unbanned: true as const };
  });
}
