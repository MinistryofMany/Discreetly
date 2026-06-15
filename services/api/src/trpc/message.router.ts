import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { RLNFullProof } from 'rlnjs';
import { prisma } from '@discreetly/db';
import { router, publicProcedure } from './trpc.js';
import { sendMessage } from '../messaging/pipeline.js';
import { assertRoomReadable } from '../gate/read-access.js';

export const messageRouter = router({
  send: publicProcedure
    .input(
      z.object({
        roomId: z.string(),
        content: z.string(),
        proof: z.unknown(),
        sessionColor: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) =>
      sendMessage({
        roomId: input.roomId,
        content: input.content,
        proof: input.proof as RLNFullProof,
        sessionColor: input.sessionColor,
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
        },
      });
      return messages.map((m) => ({
        kind: 'message' as const,
        id: m.id,
        roomId: m.roomId,
        epoch: m.epoch.toString(),
        content: m.content,
        sessionColor: m.sessionColor ?? undefined,
        createdAt: m.createdAt.toISOString(),
      }));
    }),
});
