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
});
