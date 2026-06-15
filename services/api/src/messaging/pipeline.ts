import { prisma } from '@discreetly/db';
import type { RLNFullProof } from 'rlnjs';
import { verifyMessage } from './verify-message.js';
import { checkCollision } from './collision.js';
import { banOnCollision } from './ban.js';
import { publishMessage, type BroadcastMessage } from '../realtime/broadcast.js';

export interface SendInput {
  roomId: string;
  content: string;
  proof: RLNFullProof;
  sessionColor?: string;
}

export type SendResult =
  | { status: 'sent'; message: BroadcastMessage }
  | { status: 'duplicate' }
  | { status: 'banned' }
  | { status: 'rejected'; reason: string };

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
  if (!verified.ok) return { status: 'rejected', reason: verified.reason };

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

  const collision = await checkCollision({
    roomId: room.id,
    epoch: verified.epoch,
    nullifier: verified.nullifier,
    x: verified.x,
  });
  if (collision.kind === 'duplicate') return { status: 'duplicate' };
  if (collision.kind === 'collision') return handleCollision(collision.prior.x, collision.prior.y);

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
