import { TRPCError } from '@trpc/server';
import { prisma, MembershipStatus } from '@discreetly/db';
import { joinNullifier } from './join-nullifier.js';
import type { VerifyFn } from '../trpc/trpc.js';

export interface RoomReadCtx {
  id: string;
  visibility: string;
  rlnIdentifier: string;
}

/**
 * Throws a TRPCError unless the caller may READ this room.
 * PUBLIC: always allowed. PRIVATE: requires a valid idToken whose Minister
 * identity has an ACTIVE membership in the room.
 */
export async function assertRoomReadable(
  room: RoomReadCtx,
  idToken: string | undefined,
  verify: VerifyFn,
): Promise<void> {
  if (room.visibility === 'PUBLIC') return;
  if (!idToken) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'private room requires idToken' });
  }
  let sub: string;
  try {
    ({ sub } = await verify(idToken));
  } catch {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid idToken' });
  }
  const jn = joinNullifier(sub, BigInt(room.rlnIdentifier)).toString();
  const membership = await prisma.membership.findUnique({
    where: { roomId_joinNullifier: { roomId: room.id, joinNullifier: jn } },
    select: { status: true },
  });
  if (!membership || membership.status !== MembershipStatus.ACTIVE) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'not a member of this room' });
  }
}
