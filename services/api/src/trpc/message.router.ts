import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { RlnProof } from '@ministryofmany/rln';
import { prisma } from '@discreetly/db';
import { router, publicProcedure } from './trpc.js';
import { sendMessage } from '../messaging/pipeline.js';
import { assertRoomReadable } from '../gate/read-access.js';
import { TOMBSTONE_MARKER } from '../realtime/broadcast.js';

export const messageRouter = router({
  send: publicProcedure
    .input(
      z.object({
        roomId: z.string(),
        // Cap attacker-controlled message size (storage/bandwidth DoS). AES
        // ciphertext is larger than plaintext, so the bound is generous.
        content: z.string().max(16384),
        proof: z.unknown(),
        sessionColor: z.string().max(64).optional(),
        // Moderation author link: the sender's own random membership secret
        // (64 hex chars), issued by membership.join. The pipeline resolves it
        // to a membership of THIS room and stores the membershipId
        // operator-only; unknown/forged values are dropped. Optional by
        // design - the RLN proof alone authorizes the send (see pipeline.ts).
        authorToken: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      }),
    )
    .mutation(async ({ input }) =>
      sendMessage({
        roomId: input.roomId,
        content: input.content,
        proof: input.proof as RlnProof,
        sessionColor: input.sessionColor,
        authorToken: input.authorToken,
      }),
    ),

  subscribe: publicProcedure
    .input(z.object({ roomId: z.string(), idToken: z.string().optional() }))
    .subscription(async function* (opts) {
      const room = await prisma.room.findUnique({
        where: { id: opts.input.roomId },
        select: { id: true, visibility: true, rlnIdentifier: true },
      });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });
      await assertRoomReadable(room, opts.input.idToken, opts.ctx.verify);
      const { roomMessages } = await import('../realtime/broadcast.js');
      const signal = opts.signal ?? new AbortController().signal;
      for await (const msg of roomMessages(room.id, signal)) {
        yield msg;
      }
    }),

  /**
   * Recent persisted history for a room (newest-first), so a refresh or a late
   * joiner sees existing messages instead of a blank feed. Same read gate as
   * subscribe. EPHEMERAL rooms keep no history and always return `[]`.
   * The id_token is preferred from the Authorization header (ctx.adminIdToken);
   * the optional input is a fallback for non-browser callers / tests.
   */
  list: publicProcedure
    .input(
      z.object({
        roomId: z.string(),
        idToken: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ input, ctx }) => {
      const room = await prisma.room.findUnique({
        where: { id: input.roomId },
        select: { id: true, visibility: true, rlnIdentifier: true, persistence: true },
      });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });
      await assertRoomReadable(room, ctx.adminIdToken ?? input.idToken, ctx.verify);
      if (room.persistence !== 'PERSISTENT') return [];
      const messages = await prisma.message.findMany({
        where: { roomId: room.id },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
        select: {
          id: true,
          roomId: true,
          epoch: true,
          content: true,
          sessionColor: true,
          createdAt: true,
          deletedAt: true,
        },
      });
      return messages.map((m) => {
        // Tombstoned messages render the operator marker in place; their purged
        // content/sessionColor are never returned. `deleted` lets the client
        // style the row (and skip AES decryption — content is purged, not
        // ciphertext).
        const deleted = m.deletedAt !== null;
        return {
          kind: 'message' as const,
          id: m.id,
          roomId: m.roomId,
          epoch: m.epoch.toString(),
          content: deleted ? TOMBSTONE_MARKER : m.content,
          sessionColor: deleted ? undefined : (m.sessionColor ?? undefined),
          createdAt: m.createdAt.toISOString(),
          deleted,
        };
      });
    }),
});
