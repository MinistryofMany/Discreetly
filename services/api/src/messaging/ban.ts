import { prisma, BanReason } from '@discreetly/db';
import {
  shamirRecovery,
  getIdentityCommitmentFromSecret,
  getRateCommitmentHash,
} from '@discreetly/crypto';
import { banMembershipByLeaf, type BanByLeafOutcome } from '../admin/ban-admin.js';
import { audit } from '../admin/audit.js';

/** Synthetic actor recorded on audit rows for RLN rate-limit collision bans. */
export const RLN_COLLISION_ACTOR = 'system:rln-collision';

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

  return prisma.$transaction(async (tx) => {
    const outcome = await banMembershipByLeaf(tx, {
      roomId: input.roomId,
      rateCommitment,
      reason: BanReason.RATE_LIMIT_COLLISION,
      shamirSecret: secret.toString(),
    });
    if (!outcome.banned) return outcome;
    await audit(
      {
        actor: RLN_COLLISION_ACTOR,
        action: 'RATE_LIMIT_COLLISION',
        target: input.roomId,
        metadata: {
          joinNullifier: outcome.joinNullifier,
          rateCommitment,
          prunedLeaves: outcome.prunedLeaves,
        },
      },
      tx,
    );
    return outcome;
  });
}
