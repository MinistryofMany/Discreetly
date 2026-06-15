import { z } from 'zod';
import type { RLNFullProof } from 'rlnjs';
import { router, publicProcedure } from './trpc.js';
import { sendMessage } from '../messaging/pipeline.js';

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
    .input(z.object({ roomId: z.string() }))
    .subscription(async function* (opts) {
      const { roomMessages } = await import('../realtime/broadcast.js');
      const signal = opts.signal ?? new AbortController().signal;
      for await (const msg of roomMessages(opts.input.roomId, signal)) {
        yield msg;
      }
    }),
});
