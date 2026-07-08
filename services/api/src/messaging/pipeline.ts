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
   * Moderation author link: the sender's own random membership secret
   * (`Membership.authorToken`, issued by membership.join). The pipeline
   * resolves it to a membership of THIS room and stores the membershipId;
   * unknown or cross-room values are dropped (stored as null). Because the
   * token is server-generated 256-bit randomness - NOT derivable from any
   * public value - a sender can only ever link a message to a membership
   * whose secret they actually hold, so nobody can frame another member. The
   * RLN proof is anonymous within the tree, so a modified client can omit
   * the token: it is a good-faith moderation affordance (admin ban-author),
   * NOT a security control. DELIBERATE PRIVACY TRADE-OFF: for stock clients
   * this links messages to the sender's membership for the operator/database
   * across epochs. It is never exposed via public message outputs.
   */
  authorToken?: string;
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

  // Resolve the author-link secret to a membership of THIS room; anything
  // unknown - a forged/guessed token, or a real token replayed from another
  // room - is dropped (stored as null), so a message can never be attributed
  // to a member whose secret the sender does not hold. See SendInput.
  let senderMembershipId: string | null = null;
  if (input.authorToken) {
    const membership = await prisma.membership.findUnique({
      where: { authorToken: input.authorToken },
      select: { id: true, roomId: true },
    });
    if (membership && membership.roomId === room.id) senderMembershipId = membership.id;
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
        senderMembershipId,
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
