import { prisma, MembershipStatus, type Room } from '@discreetly/db';
import { getRateCommitmentHash } from '@discreetly/crypto';

export interface JoinArgs {
  room: Pick<Room, 'id' | 'rlnIdentifier' | 'userMessageLimit' | 'maxDevices'>;
  joinNullifier: string;
  identityCommitment: string;
  deviceLabel?: string;
}

export type JoinResult =
  | { ok: true; membershipId: string; leafId: string; rateCommitment: string }
  | { ok: false; reason: 'banned' | 'already-on-device' | 'device-limit' };

function rateCommitmentFor(ic: string, limit: number): string {
  return getRateCommitmentHash(BigInt(ic), limit).toString();
}

/** Join (or add a device to) a room membership. */
export async function joinRoom(args: JoinArgs): Promise<JoinResult> {
  const rateCommitment = rateCommitmentFor(args.identityCommitment, args.room.userMessageLimit);
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.upsert({
      where: { roomId_joinNullifier: { roomId: args.room.id, joinNullifier: args.joinNullifier } },
      create: { roomId: args.room.id, joinNullifier: args.joinNullifier },
      update: {},
    });
    if (membership.status === MembershipStatus.BANNED) return { ok: false as const, reason: 'banned' as const };

    // Serialize concurrent joins for the same membership so the device-limit
    // count-then-create below is race-free.
    await tx.$queryRaw`SELECT 1 FROM "Membership" WHERE id = ${membership.id} FOR UPDATE`;

    const existing = await tx.membershipLeaf.findUnique({
      where: { roomId_rateCommitment: { roomId: args.room.id, rateCommitment } },
    });
    if (existing) return { ok: false as const, reason: 'already-on-device' as const };

    const activeLeaves = await tx.membershipLeaf.count({
      where: { membershipId: membership.id, revokedAt: null },
    });
    if (activeLeaves >= args.room.maxDevices) return { ok: false as const, reason: 'device-limit' as const };

    const leaf = await tx.membershipLeaf.create({
      data: {
        membershipId: membership.id,
        roomId: args.room.id,
        identityCommitment: args.identityCommitment,
        rateCommitment,
        deviceLabel: args.deviceLabel,
      },
    });
    return { ok: true as const, membershipId: membership.id, leafId: leaf.id, rateCommitment };
  });
}

export interface RotateArgs {
  room: Pick<Room, 'id' | 'userMessageLimit'>;
  joinNullifier: string;
  oldIdentityCommitment: string;
  newIdentityCommitment: string;
}

export type RotateResult =
  | { ok: true; rateCommitment: string }
  | { ok: false; reason: 'banned' | 'no-membership' | 'old-leaf-not-found' };

/** Replace one device leaf's identity commitment (RLN-secret rotation). */
export async function rotateDevice(args: RotateArgs): Promise<RotateResult> {
  const oldRc = rateCommitmentFor(args.oldIdentityCommitment, args.room.userMessageLimit);
  const newRc = rateCommitmentFor(args.newIdentityCommitment, args.room.userMessageLimit);
  return prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { roomId_joinNullifier: { roomId: args.room.id, joinNullifier: args.joinNullifier } },
    });
    if (!membership) return { ok: false as const, reason: 'no-membership' as const };
    if (membership.status === MembershipStatus.BANNED) return { ok: false as const, reason: 'banned' as const };

    const old = await tx.membershipLeaf.findUnique({
      where: { roomId_rateCommitment: { roomId: args.room.id, rateCommitment: oldRc } },
    });
    if (!old || old.membershipId !== membership.id) return { ok: false as const, reason: 'old-leaf-not-found' as const };

    await tx.membershipLeaf.update({
      where: { id: old.id },
      data: { identityCommitment: args.newIdentityCommitment, rateCommitment: newRc },
    });
    return { ok: true as const, rateCommitment: newRc };
  });
}
