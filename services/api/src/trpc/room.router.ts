import { z } from 'zod';
import { prisma } from '@discreetly/db';
import { router, publicProcedure } from './trpc.js';

export const roomRouter = router({
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => prisma.room.findUnique({ where: { id: input.id } })),
  listPublic: publicProcedure.query(async () =>
    prisma.room.findMany({ where: { visibility: 'PUBLIC' }, orderBy: { createdAt: 'desc' } }),
  ),
  leaves: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const leaves = await prisma.membershipLeaf.findMany({
      where: { roomId: input.id, revokedAt: null },
      select: { rateCommitment: true },
    });
    return leaves.map((l) => l.rateCommitment);
  }),
});
