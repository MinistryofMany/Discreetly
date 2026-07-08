import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { prisma } from '@discreetly/db';
import { router, publicProcedure } from './trpc.js';
import { assertRoomReadable } from '../gate/read-access.js';
import { PUBLIC_ROOM_FIELDS } from './room-fields.js';

export const roomRouter = router({
  get: publicProcedure
    .input(z.object({ id: z.string(), idToken: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const room = await prisma.room.findUnique({ where: { id: input.id }, select: PUBLIC_ROOM_FIELDS });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });
      // PRIVATE rooms: same gate as leaves/subscribe (members only). PUBLIC: open.
      // Prefer the Authorization header bearer; fall back to the input for callers
      // (e.g. tests) that pass it explicitly.
      await assertRoomReadable(room, ctx.adminIdToken ?? input.idToken, ctx.verify);
      return room;
    }),
  listPublic: publicProcedure.query(async () =>
    prisma.room.findMany({
      where: { visibility: 'PUBLIC' },
      // Operator-pinned rooms first (seeded/starter rooms), then newest.
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      select: PUBLIC_ROOM_FIELDS,
    }),
  ),
  leaves: publicProcedure
    .input(z.object({ id: z.string(), idToken: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const room = await prisma.room.findUnique({
        where: { id: input.id },
        select: { id: true, visibility: true, rlnIdentifier: true },
      });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });
      await assertRoomReadable(room, ctx.adminIdToken ?? input.idToken, ctx.verify);
      const leaves = await prisma.membershipLeaf.findMany({
        where: { roomId: input.id, revokedAt: null },
        select: { rateCommitment: true },
      });
      return leaves.map((l) => l.rateCommitment);
    }),
});
