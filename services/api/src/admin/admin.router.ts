import { z } from 'zod';
import { prisma } from '@discreetly/db';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc/trpc.js';
import { banByIdentityCommitment, banByJoinNullifier, unban } from './ban-admin.js';

export const adminRouter = router({
  whoami: adminProcedure.query(({ ctx }) => ({ adminSub: ctx.adminSub })),

  banByIdentityCommitment: adminProcedure
    .input(z.object({ roomId: z.string(), identityCommitment: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const room = await prisma.room.findUnique({
        where: { id: input.roomId },
        select: { userMessageLimit: true },
      });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });
      return banByIdentityCommitment({
        roomId: input.roomId,
        identityCommitment: input.identityCommitment,
        userMessageLimit: room.userMessageLimit,
        actor: ctx.adminSub,
      });
    }),

  banByJoinNullifier: adminProcedure
    .input(z.object({ roomId: z.string(), joinNullifier: z.string() }))
    .mutation(async ({ input, ctx }) =>
      banByJoinNullifier({
        roomId: input.roomId,
        joinNullifier: input.joinNullifier,
        actor: ctx.adminSub,
      }),
    ),

  unban: adminProcedure
    .input(z.object({ roomId: z.string(), joinNullifier: z.string() }))
    .mutation(async ({ input, ctx }) =>
      unban({ roomId: input.roomId, joinNullifier: input.joinNullifier, actor: ctx.adminSub }),
    ),
});
