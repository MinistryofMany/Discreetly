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
  room: Pick<Room, 'id' | 'rlnIdentifier' | 'userMessageLimit'>;
  joinNullifier: string;
  identityCommitment: string;
  /**
   * The verified `minister_anon_epoch` from the joiner's id_token (undefined
   * when the token carries no epoch claim). Stamped onto the membership as the
   * initial `anonEpoch` when this join creates the leaf, so a later
   * `rotateDevice` must present a STRICTLY greater epoch (audit finding C1).
   */
  tokenEpoch?: number;
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
        // First key for this membership: stamp the id_token epoch so a later
        // rotate must strictly exceed it (C1). Absent-epoch tokens start at 0.
        anonEpoch: args.tokenEpoch ?? 0,
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

    // One leaf per membership, hardcoded (D-2): the old per-device `maxDevices`
    // was a rate-limit multiplier in the clear - each extra leaf is a disjoint
    // RLN nullifier stream, so N leaves = N× the advertised message rate. Every
    // device of a user now derives the SAME per-room commitment, so a legitimate
    // second device lands on `already-on-device` above; a DIFFERENT commitment
    // while a leaf exists is a re-key and must go through `rotateDevice` (epoch
    // gated), never a second leaf here.
    const activeLeaves = await tx.membershipLeaf.count({
      where: { membershipId: membership.id, revokedAt: null },
    });
    if (activeLeaves >= 1) return { ok: false as const, reason: 'device-limit' as const };

    const leaf = await tx.membershipLeaf.create({
      data: {
        membershipId: membership.id,
        roomId: args.room.id,
        identityCommitment: args.identityCommitment,
        rateCommitment,
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
  newIdentityCommitment: string;
  /**
   * The verified `minister_anon_epoch` from the id_token authorizing the
   * rotation. The write is accepted ONLY when this STRICTLY exceeds the
   * membership's stored `anonEpoch` (audit finding C1). Undefined (no epoch
   * claim) is refused: a leaf can never be replaced without an authenticated
   * epoch to advance past.
   */
  tokenEpoch?: number;
}

export type RotateResult =
  | { ok: true; rateCommitment: string }
  | {
      ok: false;
      reason: 'banned' | 'no-membership' | 'no-leaf' | 'new-leaf-exists' | 'stale-epoch';
    };

/**
 * Replace this membership's single leaf with a new identity commitment
 * (a Ministry re-key). The membership is resolved SERVER-SIDE from the verified
 * pairwise sub (via `joinNullifier`) - the caller never supplies its old
 * commitment - and the swap is gated on the signed id_token epoch STRICTLY
 * ADVANCING past the last-keyed epoch. That is the whole of finding C1: without
 * it, `rotate` is an ungated, unlimited leaf-replacement primitive, and a client
 * can loop "replace my leaf, send N messages, replace again" for unbounded
 * messages, defeating RLN's per-identity-per-epoch rate limit. With it, a
 * replacement requires Ministry to bump the epoch (a cooldowned, AAL2-gated
 * re-key), so the loop is impossible.
 */
export async function rotateDevice(args: RotateArgs): Promise<RotateResult> {
  const newRc = rateCommitmentFor(args.newIdentityCommitment, args.room.userMessageLimit);
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { roomId_joinNullifier: { roomId: args.room.id, joinNullifier: args.joinNullifier } },
    });
    if (!membership) return { ok: false as const, reason: 'no-membership' as const };
    if (membership.status === MembershipStatus.BANNED)
      return { ok: false as const, reason: 'banned' as const };

    // C1: the epoch must strictly advance. An equal-or-lower epoch (a stale or
    // replayed token, or a loop attempt) is refused with NO write. An absent
    // epoch cannot advance anything, so it is refused too.
    if (args.tokenEpoch === undefined || args.tokenEpoch <= membership.anonEpoch)
      return { ok: false as const, reason: 'stale-epoch' as const };

    // Resolve THE membership's active leaf (one per membership, D-2) from the
    // sub-derived membership alone; the client supplies no old commitment.
    const old = await tx.membershipLeaf.findFirst({
      where: { membershipId: membership.id, revokedAt: null },
    });
    if (!old) return { ok: false as const, reason: 'no-leaf' as const };

    const collision = await tx.membershipLeaf.findUnique({
      where: { roomId_rateCommitment: { roomId: args.room.id, rateCommitment: newRc } },
    });
    if (collision && collision.id !== old.id)
      return { ok: false as const, reason: 'new-leaf-exists' as const };

    await tx.membershipLeaf.update({
      where: { id: old.id },
      data: { identityCommitment: args.newIdentityCommitment, rateCommitment: newRc },
    });
    await tx.membership.update({
      where: { id: membership.id },
      data: { anonEpoch: args.tokenEpoch },
    });
    return { ok: true as const, rateCommitment: newRc };
  });
}
