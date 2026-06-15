import { prisma, BanReason, MembershipStatus } from '@discreetly/db';
import {
  shamirRecovery,
  getIdentityCommitmentFromSecret,
  getRateCommitmentHash,
} from '@discreetly/crypto';

export interface BanInput {
  roomId: string;
  userMessageLimit: number;
  x1: string;
  y1: string; // prior (stored) point
  x2: string;
  y2: string; // new (colliding) point
}

export type BanOutcome =
  | { banned: true; joinNullifier: string; prunedLeaves: number }
  | { banned: false; reason: 'no-leaf' };

/** Recover the spammer's secret via Shamir, find their leaf, ban the membership (prune all its leaves). */
export async function banOnCollision(input: BanInput): Promise<BanOutcome> {
  const secret = shamirRecovery(
    BigInt(input.x1),
    BigInt(input.x2),
    BigInt(input.y1),
    BigInt(input.y2),
  );
  const identityCommitment = getIdentityCommitmentFromSecret(secret);
  const rateCommitment = getRateCommitmentHash(
    identityCommitment,
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
        reason: BanReason.RATE_LIMIT_COLLISION,
        shamirSecret: secret.toString(),
      },
    });
    return {
      banned: true as const,
      joinNullifier: membership.joinNullifier,
      prunedLeaves: pruned.count,
    };
  });
}
