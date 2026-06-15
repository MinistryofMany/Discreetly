import { prisma, BanReason } from '@discreetly/db';
import {
  shamirRecovery,
  getIdentityCommitmentFromSecret,
  getRateCommitmentHash,
} from '@discreetly/crypto';
import { banMembershipByLeaf, type BanByLeafOutcome } from '../admin/ban-admin.js';

export interface BanInput {
  roomId: string;
  userMessageLimit: number;
  x1: string;
  y1: string; // prior (stored) point
  x2: string;
  y2: string; // new (colliding) point
}

export type BanOutcome = BanByLeafOutcome;

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

  return prisma.$transaction(async (tx) =>
    banMembershipByLeaf(tx, {
      roomId: input.roomId,
      rateCommitment,
      reason: BanReason.RATE_LIMIT_COLLISION,
      shamirSecret: secret.toString(),
    }),
  );
}
