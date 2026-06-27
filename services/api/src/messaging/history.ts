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
 * Anonymity / RLN-slashing safety (audit finding M1): a row in the live RLN
 * collision window (`epoch` within `currentEpoch ± 1`) is NEVER pruned, even if
 * more than `cap` strictly-newer rows exist. Collision detection
 * (`collision.ts`) needs the prior colliding row of the same `(roomId, epoch,
 * nullifier)` to still exist to slash a double-signal; the verifier accepts any
 * proof whose `epoch` is within `currentEpoch ± 1` (`verify-message.ts`), so the
 * three epochs `currentEpoch-1, currentEpoch, currentEpoch+1` are live. The
 * delete `where` therefore additionally requires `epoch < currentEpoch - 1`:
 * rows in the live window are excluded from pruning unconditionally rather than
 * relying on the implicit, config-sensitive assumption that the newest `cap`
 * rows always cover the live window. A room may transiently hold slightly more
 * than `cap` rows when the newest include live-window rows that cannot be
 * pruned; this is bounded and acceptable. The count-based prune still applies to
 * rows outside the live window.
 *
 * `currentEpoch` MUST be the same value the slashing path uses — at the
 * `pipeline.ts` call site that is `Math.floor(Date.now() / room.rateLimit)`,
 * i.e. the just-inserted message's epoch. The caller threads it in.
 *
 * The prune touches only the `Message` table; it never affects membership (the
 * Merkle tree built from `MembershipLeaf`) or rate-limit accounting.
 *
 * Accepts an optional transaction client so it can join the insert transaction.
 */
export async function pruneRoomHistory(
  roomId: string,
  currentEpoch: bigint,
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
  //
  // RLN safety (M1): AND a hard guard that the row's epoch is strictly older
  // than the live collision window. `epoch < currentEpoch - 1` keeps every row
  // in `currentEpoch-1 .. currentEpoch+1` regardless of count/recency, so the
  // prior colliding row is always available to the slashing path.
  const result = await client.message.deleteMany({
    where: {
      roomId,
      epoch: { lt: currentEpoch - 1n },
      OR: [
        { createdAt: { lt: edge.createdAt } },
        { createdAt: edge.createdAt, id: { lt: edge.id } },
      ],
    },
  });
  return { pruned: result.count };
}
