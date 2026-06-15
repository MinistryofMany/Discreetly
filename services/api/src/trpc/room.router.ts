import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { prisma } from '@discreetly/db';
import { router, publicProcedure } from './trpc.js';
import { assertRoomReadable } from '../gate/read-access.js';

export const roomRouter = router({
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) =>
    prisma.room.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        rlnIdentifier: true,
        rateLimit: true,
        userMessageLimit: true,
        maxDevices: true,
        visibility: true,
        persistence: true,
        encryption: true,
        accessPolicy: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ),
  listPublic: publicProcedure.query(async () =>
    prisma.room.findMany({ where: { visibility: 'PUBLIC' }, orderBy: { createdAt: 'desc' } }),
  ),
  leaves: publicProcedure
    .input(z.object({ id: z.string(), idToken: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const room = await prisma.room.findUnique({
        where: { id: input.id },
        select: { id: true, visibility: true, rlnIdentifier: true },
      });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });
      await assertRoomReadable(room, input.idToken, ctx.verify);
      const leaves = await prisma.membershipLeaf.findMany({
        where: { roomId: input.id, revokedAt: null },
        select: { rateCommitment: true },
      });
      return leaves.map((l) => l.rateCommitment);
    }),
});
