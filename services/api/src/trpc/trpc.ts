import { initTRPC, TRPCError } from '@trpc/server';
import { prisma } from '@discreetly/db';
import type { VerifiedIdentity } from '../minister/verify.js';
import { formatTrpcError } from './error-formatter.js';

export type VerifyFn = (idToken: string) => Promise<VerifiedIdentity>;

export interface Context {
  verify: VerifyFn;
  /**
   * Raw Bearer id_token from the Authorization header. Used by `adminProcedure`
   * and as the preferred source of the caller's id_token for room read gating,
   * so the token travels in the header (never in a query input / URL).
   */
  adminIdToken?: string;
}

const t = initTRPC.context<Context>().create({
  errorFormatter: (opts) => formatTrpcError(opts),
});
export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Procedure that requires a valid Minister id_token (Authorization: Bearer)
 * whose pairwise `sub` is in the `AdminUser` allowlist. Injects `ctx.adminSub`.
 */
export const adminProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.adminIdToken) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'admin auth required' });
  }
  let sub: string;
  try {
    ({ sub } = await ctx.verify(ctx.adminIdToken));
  } catch {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid admin id_token' });
  }
  const admin = await prisma.adminUser.findUnique({ where: { pairwiseSub: sub } });
  if (!admin) throw new TRPCError({ code: 'FORBIDDEN', message: 'not an admin' });
  return next({ ctx: { ...ctx, adminSub: sub } });
});
