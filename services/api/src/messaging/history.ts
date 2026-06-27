import { prisma, type Prisma } from '@discreetly/db';

/**
 * Per-room history cap (ring buffer). A PERSISTENT room retains only its newest
 * MAX_ROOM_MESSAGES messages; older rows are pruned on write. Tombstoned
 * (operator-deleted) rows still occupy a slot — they are part of history.
 *
 * Fixed at 1000 for now. A named constant so the operator can tune it later
 * without hunting for a magic number; not yet a per-room column or env var
 * (would be unrequested scope).
 */
export const MAX_ROOM_MESSAGES = 1000;

/**
 * Prune a room's persisted messages down to the newest `cap` by `createdAt`
 * (tie-broken by `id` for a total, stable order). Deletes only the oldest rows
 * beyond the cap; a no-op once the room is at or under the cap.
 *
 * Anonymity note: this only ever deletes the OLDEST rows. RLN collision
 * detection (`collision.ts`) reads only messages in the current epoch window
 * (`currentEpoch ± 1`), which are by definition the newest rows and so are the
 * last to be pruned — never evicted while still in the live window. The prune
 * touches only the `Message` table; it never affects membership (the Merkle
 * tree built from `MembershipLeaf`) or rate-limit accounting.
 *
 * Accepts an optional transaction client so it can join the insert transaction.
 */
export async function pruneRoomHistory(
  roomId: string,
  cap: number = MAX_ROOM_MESSAGES,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ pruned: number }> {
  // Find the boundary row: the `cap`-th newest message (1-indexed). Anything
  // strictly older than it is pruned. If fewer than `cap` rows exist, there is
  // no boundary and nothing to prune.
  const boundary = await client.message.findMany({
    where: { roomId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: cap - 1,
    take: 1,
    select: { createdAt: true, id: true },
  });
  const edge = boundary[0];
  if (!edge) return { pruned: 0 };

  // Delete rows older than the boundary by (createdAt, id) — i.e. strictly
  // before the kept window. Rows with the same createdAt but a smaller id than
  // the boundary are also older in the total order and are pruned.
  const result = await client.message.deleteMany({
    where: {
      roomId,
      OR: [
        { createdAt: { lt: edge.createdAt } },
        { createdAt: edge.createdAt, id: { lt: edge.id } },
      ],
    },
  });
  return { pruned: result.count };
}
