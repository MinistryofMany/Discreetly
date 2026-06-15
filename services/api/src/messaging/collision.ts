import { prisma } from '@discreetly/db';

export interface PriorPoint {
  x: string;
  y: string;
}

export type CollisionCheck =
  | { kind: 'new' }
  | { kind: 'duplicate' }
  | { kind: 'collision'; prior: PriorPoint };

/** Look for a stored message sharing this nullifier in the same room+epoch. */
export async function checkCollision(args: {
  roomId: string;
  epoch: bigint;
  nullifier: string;
  x: string;
}): Promise<CollisionCheck> {
  const prior = await prisma.message.findFirst({
    where: { roomId: args.roomId, epoch: args.epoch, rlnNullifier: args.nullifier },
    select: { proof: true },
  });
  if (!prior) return { kind: 'new' };
  const ps = (
    prior.proof as { snarkProof: { publicSignals: { x: string; y: string } } }
  ).snarkProof.publicSignals;
  if (String(ps.x) === args.x) return { kind: 'duplicate' };
  return { kind: 'collision', prior: { x: String(ps.x), y: String(ps.y) } };
}
