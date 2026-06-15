import { z } from 'zod';
import { prisma } from '@discreetly/db';
import type { PolicyNode } from '@discreetly/policy';
import { router, publicProcedure } from './trpc.js';
import { evaluateGate } from '../gate/gate.js';
import { joinRoom, rotateDevice } from '../membership/membership.js';

export const membershipRouter = router({
  join: publicProcedure
    .input(
      z.object({
        roomId: z.string(),
        idToken: z.string(),
        identityCommitment: z.string(),
        deviceLabel: z.string().max(100).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const room = await prisma.room.findUnique({ where: { id: input.roomId } });
      if (!room) return { ok: false as const, reason: 'no-room' as const };
      const gate = await evaluateGate({
        idToken: input.idToken,
        rlnIdentifier: BigInt(room.rlnIdentifier),
        policy: room.accessPolicy as unknown as PolicyNode,
        verify: ctx.verify,
      });
      if (!gate.allowed) return { ok: false as const, reason: 'policy-denied' as const };
      return joinRoom({
        room,
        joinNullifier: gate.joinNullifier.toString(),
        identityCommitment: input.identityCommitment,
        deviceLabel: input.deviceLabel,
      });
    }),
  rotate: publicProcedure
    .input(
      z.object({
        roomId: z.string(),
        idToken: z.string(),
        oldIdentityCommitment: z.string(),
        newIdentityCommitment: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const room = await prisma.room.findUnique({ where: { id: input.roomId } });
      if (!room) return { ok: false as const, reason: 'no-room' as const };
      const gate = await evaluateGate({
        idToken: input.idToken,
        rlnIdentifier: BigInt(room.rlnIdentifier),
        policy: room.accessPolicy as unknown as PolicyNode,
        verify: ctx.verify,
      });
      if (!gate.allowed) return { ok: false as const, reason: 'policy-denied' as const };
      return rotateDevice({
        room,
        joinNullifier: gate.joinNullifier.toString(),
        oldIdentityCommitment: input.oldIdentityCommitment,
        newIdentityCommitment: input.newIdentityCommitment,
      });
    }),
});
