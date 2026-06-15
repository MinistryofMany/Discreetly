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
});
