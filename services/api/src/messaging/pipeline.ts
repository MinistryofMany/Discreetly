import { randomUUID } from 'node:crypto';
import { prisma } from '@discreetly/db';
import type { RlnProof } from '@ministryofmany/rln';
import { verifyMessage } from './verify-message.js';
import { checkCollision } from './collision.js';
import { checkEphemeralCollision } from './ephemeral-collision.js';
import { banOnCollision } from './ban.js';
import { pruneRoomHistory } from './history.js';
import { publishMessage, type BroadcastMessage } from '../realtime/broadcast.js';

export interface SendInput {
  roomId: string;
  content: string;
  proof: RlnProof;
  sessionColor?: string;
  /**
   * CLIENT-ASSERTED moderation link: the sender's own join nullifier. The RLN
   * proof is anonymous within the tree, so the server CANNOT derive or verify
   * ownership of this value - it only validates that it matches an EXISTING
   * membership of the room (anything else is dropped, stored as null). The
   * stock client always attaches it; a modified client can omit it, so it is a
   * good-faith moderation affordance (admin ban-author), NOT a security
   * control. DELIBERATE PRIVACY TRADE-OFF: for stock clients this links
   * messages to the sender's membership for the operator/database across
   * epochs. It is never exposed via public message outputs.
   */
  joinNullifier?: string;
}

export type SendResult =
  | { status: 'sent'; message: BroadcastMessage }
  | { status: 'duplicate' }
  | { status: 'banned' }
  | { status: 'rejected'; reason: string }
  // Malformed/unparseable proof envelope. Distinct, typed failure so a client
  // sending `{proof:{}}` gets a structured response instead of a 500.
  | { ok: false; reason: 'bad-proof' };

function isP2002(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

export async function sendMessage(input: SendInput): Promise<SendResult> {
  const room = await prisma.room.findUnique({ where: { id: input.roomId } });
  if (!room) return { status: 'rejected', reason: 'no-room' };

  const leaves = (
    await prisma.membershipLeaf.findMany({
      where: { roomId: room.id, revokedAt: null },
      select: { rateCommitment: true },
    })
  ).map((l) => l.rateCommitment);

  const currentEpoch = BigInt(Math.floor(Date.now() / room.rateLimit));
  const verified = await verifyMessage({
    rlnIdentifier: BigInt(room.rlnIdentifier),
    proof: input.proof,
    content: input.content,
    leaves,
    currentEpoch,
  });
  if (!verified.ok) {
    if (verified.reason === 'bad-proof') return { ok: false, reason: 'bad-proof' };
    return { status: 'rejected', reason: verified.reason };
  }

  const handleCollision = async (priorX: string, priorY: string): Promise<SendResult> => {
    await banOnCollision({
      roomId: room.id,
      userMessageLimit: room.userMessageLimit,
      x1: priorX,
      y1: priorY,
      x2: verified.x,
      y2: verified.y,
    });
    return { status: 'banned' };
  };

  // EPHEMERAL rooms are a pure transport relay: verify -> dedup against a
  // transient (auto-expiring) per-epoch nullifier record -> fan out over Redis
  // -> forget. No Message row is ever written; bans (membership state) still
  // persist via the shared collision path.
  if (room.persistence === 'EPHEMERAL') {
    // TTL covers the +/-1 epoch acceptance window (3 epochs wide) with margin
    // so a nullifier's point outlives every epoch in which its proof is valid.
    const ttlMs = room.rateLimit * 4;
    const eph = await checkEphemeralCollision({
      roomId: room.id,
      epoch: verified.epoch,
      nullifier: verified.nullifier,
      x: verified.x,
      y: verified.y,
      ttlMs,
    });
    if (eph.kind === 'duplicate') return { status: 'duplicate' };
    if (eph.kind === 'collision') return handleCollision(eph.prior.x, eph.prior.y);

    const message: BroadcastMessage = {
      id: randomUUID(),
      roomId: room.id,
      epoch: verified.epoch.toString(),
      content: input.content,
      sessionColor: input.sessionColor ?? undefined,
      createdAt: new Date().toISOString(),
    };
    await publishMessage(message);
    return { status: 'sent', message };
  }

  const collision = await checkCollision({
    roomId: room.id,
    epoch: verified.epoch,
    nullifier: verified.nullifier,
    x: verified.x,
  });
  if (collision.kind === 'duplicate') return { status: 'duplicate' };
  if (collision.kind === 'collision') return handleCollision(collision.prior.x, collision.prior.y);

  // Validate the client-asserted author link against an existing membership of
  // THIS room; anything unknown is dropped (stored as null) so garbage can
  // never be "banned". Ownership is unverifiable by design - see SendInput.
  let senderJoinNullifier: string | null = null;
  if (input.joinNullifier) {
    const membership = await prisma.membership.findUnique({
      where: {
        roomId_joinNullifier: { roomId: room.id, joinNullifier: input.joinNullifier },
      },
      select: { id: true },
    });
    if (membership) senderJoinNullifier = input.joinNullifier;
  }

  let stored;
  try {
    stored = await prisma.message.create({
      data: {
        roomId: room.id,
        epoch: verified.epoch,
        rlnNullifier: verified.nullifier,
        content: input.content,
        proof: input.proof as unknown as object,
        sessionColor: input.sessionColor,
        senderJoinNullifier,
      },
    });
  } catch (e) {
    if (isP2002(e)) {
      const again = await checkCollision({
        roomId: room.id,
        epoch: verified.epoch,
        nullifier: verified.nullifier,
        x: verified.x,
      });
      if (again.kind === 'duplicate') return { status: 'duplicate' };
      if (again.kind === 'collision') return handleCollision(again.prior.x, again.prior.y);
    }
    throw e;
  }

  // Ring-buffer prune: keep only this room's newest MAX_ROOM_MESSAGES rows.
  // Runs after the insert so the just-stored message counts toward the window.
  // Deletes only the oldest rows outside the RLN collision window: `currentEpoch`
  // (the same epoch the slashing path uses) is threaded in so rows in the live
  // window (`currentEpoch ± 1`) are never pruned — see history.ts (M1).
  await pruneRoomHistory(room.id, currentEpoch);

  const message: BroadcastMessage = {
    id: stored.id,
    roomId: room.id,
    epoch: verified.epoch.toString(),
    content: input.content,
    sessionColor: input.sessionColor ?? undefined,
    createdAt: stored.createdAt.toISOString(),
  };
  await publishMessage(message);
  return { status: 'sent', message };
}
