import { randomBytes } from 'node:crypto';
import { prisma, MembershipStatus, type Prisma, type Room } from '@discreetly/db';
import { getRateCommitmentHash } from '@ministryofmany/rln';

/** An interactive-transaction client (the `tx` passed to `prisma.$transaction`). */
export type TxClient = Prisma.TransactionClient;

/**
 * Random, unguessable author-link secret for a membership (32 bytes -> 64 hex
 * chars, unique-indexed). Returned only to the joiner by `membership.join`;
 * the stock client attaches it on `message.send` so the pipeline can link the
 * message to this membership for operator moderation (ban-author). Server-
 * generated randomness is the whole point: the old link (the join nullifier)
 * was deterministically derivable from a victim's pairwise sub plus the
 * PUBLIC rlnIdentifier, so anyone could frame another member.
 */
function generateAuthorToken(): string {
  return randomBytes(32).toString('hex');
}

export interface JoinArgs {
  room: Pick<Room, 'id' | 'rlnIdentifier' | 'userMessageLimit' | 'maxDevices'>;
  joinNullifier: string;
  identityCommitment: string;
  deviceLabel?: string;
  /**
   * Run inside this existing interactive transaction so the caller can compose
   * the join atomically with other writes. Omit to open a fresh one.
   */
  tx?: TxClient;
}

export type JoinResult =
  | {
      ok: true;
      membershipId: string;
      leafId: string;
      rateCommitment: string;
      /** The caller's own author-link secret for this room (see generateAuthorToken). */
      authorToken: string;
    }
  | { ok: false; reason: 'banned' | 'already-on-device' | 'device-limit' };

function rateCommitmentFor(ic: string, limit: number): string {
  return getRateCommitmentHash(BigInt(ic), limit).toString();
}

/** Join (or add a device to) a room membership. */
export async function joinRoom(args: JoinArgs): Promise<JoinResult> {
  const rateCommitment = rateCommitmentFor(args.identityCommitment, args.room.userMessageLimit);
  const run = async (tx: TxClient): Promise<JoinResult> => {
    const membership = await tx.membership.upsert({
      where: { roomId_joinNullifier: { roomId: args.room.id, joinNullifier: args.joinNullifier } },
      create: {
        roomId: args.room.id,
        joinNullifier: args.joinNullifier,
        authorToken: generateAuthorToken(),
      },
      update: {},
    });
    if (membership.status === MembershipStatus.BANNED)
      return { ok: false as const, reason: 'banned' as const };

    // Serialize concurrent joins for the same membership so the device-limit
    // count-then-create below is race-free.
    await tx.$queryRaw`SELECT 1 FROM "Membership" WHERE id = ${membership.id} FOR UPDATE`;

    // Issue the author-link secret lazily to token-less rows (created before
    // the column existed, or seeded directly). Re-read under the row lock so
    // two concurrent joins cannot both mint and silently clobber each other's
    // token - the loser would hold a secret that no longer resolves.
    let authorToken = membership.authorToken;
    if (authorToken === null) {
      const locked = await tx.membership.findUniqueOrThrow({
        where: { id: membership.id },
        select: { authorToken: true },
      });
      authorToken = locked.authorToken;
      if (authorToken === null) {
        authorToken = generateAuthorToken();
        await tx.membership.update({
          where: { id: membership.id },
          data: { authorToken },
        });
      }
    }

    const existing = await tx.membershipLeaf.findUnique({
      where: { roomId_rateCommitment: { roomId: args.room.id, rateCommitment } },
    });
    if (existing) return { ok: false as const, reason: 'already-on-device' as const };

    const activeLeaves = await tx.membershipLeaf.count({
      where: { membershipId: membership.id, revokedAt: null },
    });
    if (activeLeaves >= args.room.maxDevices)
      return { ok: false as const, reason: 'device-limit' as const };

    const leaf = await tx.membershipLeaf.create({
      data: {
        membershipId: membership.id,
        roomId: args.room.id,
        identityCommitment: args.identityCommitment,
        rateCommitment,
        deviceLabel: args.deviceLabel,
      },
    });
    return {
      ok: true as const,
      membershipId: membership.id,
      leafId: leaf.id,
      rateCommitment,
      authorToken,
    };
  };
  // Reuse the caller's transaction when given (to compose atomically with other
  // writes), otherwise open a fresh one. The leaf upsert+count must stay
  // transactional.
  return args.tx ? run(args.tx) : prisma.$transaction(run);
}

export interface RotateArgs {
  room: Pick<Room, 'id' | 'userMessageLimit'>;
  joinNullifier: string;
  oldIdentityCommitment: string;
  newIdentityCommitment: string;
}

export type RotateResult =
  | { ok: true; rateCommitment: string }
  | { ok: false; reason: 'banned' | 'no-membership' | 'old-leaf-not-found' | 'new-leaf-exists' };

/** Replace one device leaf's identity commitment (RLN-secret rotation). */
export async function rotateDevice(args: RotateArgs): Promise<RotateResult> {
  const oldRc = rateCommitmentFor(args.oldIdentityCommitment, args.room.userMessageLimit);
  const newRc = rateCommitmentFor(args.newIdentityCommitment, args.room.userMessageLimit);
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { roomId_joinNullifier: { roomId: args.room.id, joinNullifier: args.joinNullifier } },
    });
    if (!membership) return { ok: false as const, reason: 'no-membership' as const };
    if (membership.status === MembershipStatus.BANNED)
      return { ok: false as const, reason: 'banned' as const };

    const old = await tx.membershipLeaf.findUnique({
      where: { roomId_rateCommitment: { roomId: args.room.id, rateCommitment: oldRc } },
    });
    if (!old || old.membershipId !== membership.id)
      return { ok: false as const, reason: 'old-leaf-not-found' as const };

    const collision = await tx.membershipLeaf.findUnique({
      where: { roomId_rateCommitment: { roomId: args.room.id, rateCommitment: newRc } },
    });
    if (collision && collision.id !== old.id)
      return { ok: false as const, reason: 'new-leaf-exists' as const };

    await tx.membershipLeaf.update({
      where: { id: old.id },
      data: { identityCommitment: args.newIdentityCommitment, rateCommitment: newRc },
    });
    return { ok: true as const, rateCommitment: newRc };
  });
}
