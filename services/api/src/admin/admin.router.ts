import { z } from 'zod';
import { prisma, Prisma } from '@discreetly/db';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc/trpc.js';
import { banByIdentityCommitment, banByJoinNullifier, unban } from './ban-admin.js';
import { deleteMessage } from './delete-message.js';
import {
  generateRlnIdentifier,
  hashRoomPassword,
  policyToJson,
  validatePolicyInput,
} from './room-crypto.js';
import { audit } from './audit.js';
import { PUBLIC_ROOM_FIELDS } from '../trpc/room-fields.js';
import { publishSystem, publishTombstone } from '../realtime/broadcast.js';

/** Minimum length for an AES room password, enforced server-side. */
const AES_MIN_PASSWORD_LENGTH = 12;

const roomAdminRouter = router({
  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        slug: z.string().min(1).max(100),
        description: z.string().max(2000).optional(),
        rateLimit: z.number().int().positive(),
        userMessageLimit: z.number().int().positive(),
        maxDevices: z.number().int().positive().optional(),
        visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
        persistence: z.enum(['PERSISTENT', 'EPHEMERAL']).optional(),
        encryption: z.enum(['PLAINTEXT', 'AES']).optional(),
        password: z.string().max(512).optional(),
        accessPolicy: z.unknown(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const parsedPolicy = validatePolicyInput(input.accessPolicy);

      // AES rooms require a password with a minimum length (server-side floor).
      if (input.encryption === 'AES') {
        if (!input.password) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'password required for AES rooms' });
        }
        if (input.password.length < AES_MIN_PASSWORD_LENGTH) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `AES room password must be at least ${AES_MIN_PASSWORD_LENGTH} characters`,
          });
        }
      }

      const passwordHash = input.password ? await hashRoomPassword(input.password) : undefined;

      // Generate rlnIdentifier with retry on unique collision (P2002 on rlnIdentifier
      // only). A slug collision is a client error, not retryable.
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
              accessPolicy: policyToJson(parsedPolicy),
            },
            select: PUBLIC_ROOM_FIELDS,
          });
          break;
        } catch (err: unknown) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            const target = err.meta?.target;
            const fields = Array.isArray(target) ? target : target ? [String(target)] : [];
            if (fields.includes('slug')) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'slug already in use' });
            }
            // rlnIdentifier collision: retry with a fresh identifier.
            if (attempt < 4) continue;
          }
          throw err;
        }
      }

      if (!room) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'failed to generate unique rlnIdentifier',
        });
      }

      // Best-effort audit (outside the create transaction); the transactional
      // ban audits are the durable record. A failed audit here does not roll back.
      await audit({ actor: ctx.adminSub, action: 'ROOM_CREATE', target: room.id });
      return room;
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        slug: z.string().min(1).max(100).optional(),
        description: z.string().max(2000).optional(),
        rateLimit: z.number().int().positive().optional(),
        userMessageLimit: z.number().int().positive().optional(),
        maxDevices: z.number().int().positive().optional(),
        visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
        persistence: z.enum(['PERSISTENT', 'EPHEMERAL']).optional(),
        encryption: z.enum(['PLAINTEXT', 'AES']).optional(),
        password: z.string().max(512).optional(),
        accessPolicy: z.unknown().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const existing = await prisma.room.findUnique({
        where: { id: input.id },
        select: { id: true, userMessageLimit: true, encryption: true },
      });
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });

      // Enforce the AES password floor on update. The room is AES if the update
      // sets it to AES or it already is and is not being changed away.
      const willBeAes =
        input.encryption === 'AES' ||
        (input.encryption === undefined && existing.encryption === 'AES');
      if (
        willBeAes &&
        input.password !== undefined &&
        input.password.length < AES_MIN_PASSWORD_LENGTH
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `AES room password must be at least ${AES_MIN_PASSWORD_LENGTH} characters`,
        });
      }

      // Changing userMessageLimit invalidates every stored rateCommitment (it is
      // hashed with the limit), which would break the tree and ban-by-IC matching
      // for every existing member. Only allow it on an empty room.
      if (
        input.userMessageLimit !== undefined &&
        input.userMessageLimit !== existing.userMessageLimit
      ) {
        const member = await prisma.membership.findFirst({
          where: { roomId: input.id },
          select: { id: true },
        });
        if (member) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'cannot change userMessageLimit on a room with members',
          });
        }
      }

      // Re-validate accessPolicy if present
      const parsedPolicy =
        input.accessPolicy !== undefined ? validatePolicyInput(input.accessPolicy) : undefined;

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
          ...(parsedPolicy !== undefined && { accessPolicy: policyToJson(parsedPolicy) }),
          // rlnIdentifier is intentionally excluded — never updated
        },
        select: PUBLIC_ROOM_FIELDS,
      });

      await audit({ actor: ctx.adminSub, action: 'ROOM_UPDATE', target: room.id });
      return room;
    }),

  delete: adminProcedure.input(z.object({ id: z.string() })).mutation(async ({ input, ctx }) => {
    const existing = await prisma.room.findUnique({
      where: { id: input.id },
      select: { id: true },
    });
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

  get: adminProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const room = await prisma.room.findUnique({
      where: { id: input.id },
      select: PUBLIC_ROOM_FIELDS,
    });
    if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });
    return room;
  }),

  memberships: adminProcedure.input(z.object({ roomId: z.string() })).query(async ({ input }) => {
    const room = await prisma.room.findUnique({
      where: { id: input.roomId },
      select: { id: true },
    });
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

  // Operator-only emergency content moderation. Soft-deletes (tombstones) any
  // message: purges its content in place and renders it as "removed by
  // operator". The row is retained (thread order + per-room count stay
  // coherent), and the RLN accounting fields (rlnNullifier/epoch/proof) are
  // left intact so rate-limit slashing is unaffected. See delete-message.ts.
  deleteMessage: adminProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const outcome = await deleteMessage({ messageId: input.messageId, actor: ctx.adminSub });
      if (!outcome.ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'message not found' });
      // Notify open feeds to re-render the row in place. Only on a fresh delete;
      // a repeat (already-deleted) call need not re-broadcast.
      if (outcome.deleted) await publishTombstone(outcome.roomId, input.messageId);
      return { ok: true as const, alreadyDeleted: !outcome.deleted };
    }),

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
    .input(z.object({ roomId: z.string(), text: z.string().min(1).max(4096) }))
    .mutation(async ({ input, ctx }) => {
      const room = await prisma.room.findUnique({
        where: { id: input.roomId },
        select: { id: true },
      });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'room not found' });

      const createdAt = new Date().toISOString();
      // Audit before publishing: a publish failure after a logged broadcast is
      // safer than an unlogged broadcast.
      await audit({
        actor: ctx.adminSub,
        action: 'SYSTEM_BROADCAST',
        target: input.roomId,
        metadata: { text: input.text },
      });
      await publishSystem(input.roomId, input.text, createdAt);

      return { ok: true as const };
    }),
});
