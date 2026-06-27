import { prisma } from '@discreetly/db';
import { audit } from './audit.js';

export type DeleteMessageOutcome =
  | { ok: true; deleted: true; roomId: string }
  | { ok: true; deleted: false; reason: 'already-deleted'; roomId: string }
  | { ok: false; reason: 'not-found' };

export interface DeleteMessageInput {
  messageId: string;
  /** Operator's Minister pairwise sub (from adminProcedure ctx.adminSub). */
  actor: string;
}

/**
 * Operator soft-delete (tombstone) of a single message.
 *
 * Purges the user-visible payload in place — `content` -> '' and `sessionColor`
 * -> null — and stamps `deletedAt` / `deletedBy`. The row is RETAINED so thread
 * order and the per-room message count stay coherent.
 *
 * Anonymity-critical: `rlnNullifier`, `epoch`, and `proof` are intentionally
 * left untouched. RLN rate-limit collision detection (`collision.ts`) reads a
 * prior message's `rlnNullifier` and `proof` (the Shamir share point) to slash
 * a spammer; nulling them would defeat slashing for that (room, epoch,
 * nullifier). The proof is a public-signal envelope (no plaintext, no author
 * identity beyond what RLN already exposes), so retaining it leaks nothing the
 * live message did not.
 *
 * Idempotent: a second delete of an already-tombstoned message is a no-op
 * (returns `already-deleted`) and writes no further audit row.
 */
export async function deleteMessage(input: DeleteMessageInput): Promise<DeleteMessageOutcome> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.message.findUnique({
      where: { id: input.messageId },
      select: { id: true, roomId: true, deletedAt: true },
    });
    if (!existing) return { ok: false as const, reason: 'not-found' as const };
    if (existing.deletedAt !== null) {
      return {
        ok: true as const,
        deleted: false as const,
        reason: 'already-deleted' as const,
        roomId: existing.roomId,
      };
    }

    await tx.message.update({
      where: { id: input.messageId },
      data: {
        content: '',
        sessionColor: null,
        deletedAt: new Date(),
        deletedBy: input.actor,
        // rlnNullifier, epoch, proof intentionally NOT modified (RLN accounting).
      },
    });

    await audit(
      {
        actor: input.actor,
        action: 'MESSAGE_DELETE',
        target: existing.roomId,
        metadata: { messageId: existing.id },
      },
      tx,
    );

    return { ok: true as const, deleted: true as const, roomId: existing.roomId };
  });
}
