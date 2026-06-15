import { z } from 'zod';
import { prisma, type Prisma } from '@discreetly/db';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc/trpc.js';
import { banByIdentityCommitment, banByJoinNullifier, unban } from './ban-admin.js';
import { generateRlnIdentifier, hashRoomPassword } from './room-admin.js';
import { audit } from './audit.js';
import { PUBLIC_ROOM_FIELDS } from '../trpc/room-fields.js';
import { policyNodeSchema } from '@discreetly/policy';
import { publishSystem } from '../realtime/broadcast.js';

const roomAdminRouter = router({
  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        slug: z.string().min(1),
        description: z.string().optional(),
        rateLimit: z.number().int().positive(),
        userMessageLimit: z.number().int().positive(),
        maxDevices: z.number().int().positive().optional(),
        visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
        persistence: z.enum(['PERSISTENT', 'EPHEMERAL']).optional(),
        encryption: z.enum(['PLAINTEXT', 'AES']).optional(),
        password: z.string().optional(),
        accessPolicy: z.unknown(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Validate accessPolicy
      const parsedPolicy = (() => {
        try {
          return policyNodeSchema.parse(input.accessPolicy);
        } catch {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid accessPolicy' });
        }
      })();

      // AES rooms require a password
      if (input.encryption === 'AES' && !input.password) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'password required for AES rooms' });
      }

      const passwordHash = input.password ? await hashRoomPassword(input.password) : undefined;

      // Generate rlnIdentifier with retry on unique collision (P2002)
      let room;
      for (let attempt = 0; attempt < 5; attempt++) {
        const rlnIdentifier = generateRlnIdentifier(input.name);
        try {
          room = await prisma.room.create({
            data: {
              name: input.name,
              slug: input.slug,
              description: input.description,
              rlnIdentifier,
              rateLimit: input.rateLimit,
              userMessageLimit: input.userMessageLimit,
              ...(input.maxDevices !== undefined && { maxDevices: input.maxDevices }),
              ...(input.visibility !== undefined && { visibility: input.visibility }),
              ...(input.persistence !== undefined && { persistence: input.persistence }),
              ...(input.encryption !== undefined && { encryption: input.encryption }),
              ...(passwordHash !== undefined && { passwordHash }),
              accessPolicy: parsedPolicy as unknown as Prisma.InputJsonValue,
            },
            select: PUBLIC_ROOM_FIELDS,
          });
          break;
        } catch (err: unknown) {
          const isPrismaError =
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code: string }).code === 'P2002';
          if (isPrismaError && attempt < 4) continue;
          throw err;
        }
      }

      if (!room) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'failed to generate unique rlnIdentifier',
        });
      }

      await audit({ actor: ctx.adminSub, action: 'ROOM_CREATE', target: room.id });
      return room;
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        slug: z.string().min(1).optional(),
        description: z.string().optional(),
        rateLimit: z.number().int().positive().optional(),
        userMessageLimit: z.number().int().positive().optional(),
        maxDevices: z.number().int().positive().optional(),
        visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
        persistence: z.enum(['PERSISTENT', 'EPHEMERAL']).optional(),
        encryption: z.enum(['PLAINTEXT', 'AES']).optional(),
        password: z.string().optional(),
        accessPolicy: z.unknown().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const existing = await prisma.room.findUnique({ where: { id: input.id }, select: { id: true } });
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });

      // Re-validate accessPolicy if present
      let parsedPolicy: Prisma.InputJsonValue | undefined;
      if (input.accessPolicy !== undefined) {
        try {
          parsedPolicy = policyNodeSchema.parse(input.accessPolicy) as unknown as Prisma.InputJsonValue;
        } catch {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid accessPolicy' });
        }
      }

      const passwordHash = input.password ? await hashRoomPassword(input.password) : undefined;

      const room = await prisma.room.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.slug !== undefined && { slug: input.slug }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.rateLimit !== undefined && { rateLimit: input.rateLimit }),
          ...(input.userMessageLimit !== undefined && { userMessageLimit: input.userMessageLimit }),
          ...(input.maxDevices !== undefined && { maxDevices: input.maxDevices }),
          ...(input.visibility !== undefined && { visibility: input.visibility }),
          ...(input.persistence !== undefined && { persistence: input.persistence }),
          ...(input.encryption !== undefined && { encryption: input.encryption }),
          ...(passwordHash !== undefined && { passwordHash }),
          ...(parsedPolicy !== undefined && { accessPolicy: parsedPolicy }),
          // rlnIdentifier is intentionally excluded — never updated
        },
        select: PUBLIC_ROOM_FIELDS,
      });

      await audit({ actor: ctx.adminSub, action: 'ROOM_UPDATE', target: room.id });
      return room;
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const existing = await prisma.room.findUnique({ where: { id: input.id }, select: { id: true } });
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });

      await prisma.room.delete({ where: { id: input.id } });
      await audit({ actor: ctx.adminSub, action: 'ROOM_DELETE', target: input.id });
      return { ok: true as const };
    }),

  list: adminProcedure.query(async () =>
    prisma.room.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        ...PUBLIC_ROOM_FIELDS,
        _count: { select: { memberships: true, messages: true } },
      },
    }),
  ),

  get: adminProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const room = await prisma.room.findUnique({ where: { id: input.id }, select: PUBLIC_ROOM_FIELDS });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });
      return room;
    }),

  memberships: adminProcedure
    .input(z.object({ roomId: z.string() }))
    .query(async ({ input }) => {
      const room = await prisma.room.findUnique({ where: { id: input.roomId }, select: { id: true } });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });

      return prisma.membership.findMany({
        where: { roomId: input.roomId },
        select: {
          status: true,
          joinNullifier: true,
          createdAt: true,
          leaves: {
            where: { revokedAt: null },
            select: {
              identityCommitment: true,
              rateCommitment: true,
              deviceLabel: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });
    }),
});

export const adminRouter = router({
  whoami: adminProcedure.query(({ ctx }) => ({ adminSub: ctx.adminSub })),

  room: roomAdminRouter,

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

  auditLog: adminProcedure
    .input(
      z.object({
        roomId: z.string().optional(),
        actor: z.string().optional(),
        action: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    )
    .query(async ({ input }) => {
      const where: Prisma.AuditLogWhereInput = {};
      if (input.roomId !== undefined) where.target = input.roomId;
      if (input.actor !== undefined) where.actor = input.actor;
      if (input.action !== undefined) where.action = input.action;

      return prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: input.limit,
      });
    }),

  broadcast: adminProcedure
    .input(z.object({ roomId: z.string(), text: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const room = await prisma.room.findUnique({ where: { id: input.roomId }, select: { id: true } });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });

      const createdAt = new Date().toISOString();
      await publishSystem(input.roomId, input.text, createdAt);
      await audit({
        actor: ctx.adminSub,
        action: 'SYSTEM_BROADCAST',
        target: input.roomId,
        metadata: { text: input.text },
      });

      return { ok: true as const };
    }),
});
