import { initTRPC, TRPCError } from '@trpc/server';
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
  /**
   * Operator allowlist: the Minister pairwise subs allowed to call admin
   * procedures, parsed from `DISCREETLY_OPERATOR_SUBS` at server boot and
   * threaded through the context (injectable in tests). Missing or empty means
   * NO operator exists - every admin call is FORBIDDEN (fail closed).
   */
  operatorSubs?: ReadonlySet<string>;
}

const t = initTRPC.context<Context>().create({
  errorFormatter: (opts) => formatTrpcError(opts),
});
export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Message the wrapped verifier produces for an expired id_token. The SDK's
 * `MinisterTokenError` copies the underlying jose message verbatim and jose's
 * `JWTExpired` message is stable ('"exp" claim timestamp check failed'), so
 * matching on it distinguishes "expired" (re-auth fixes it) from "invalid"
 * (bad signature / issuer / audience - re-auth may not).
 */
function isExpiryError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('"exp" claim timestamp check failed');
}

/**
 * Procedure that requires a valid Minister id_token (Authorization: Bearer)
 * whose pairwise `sub` is in the `DISCREETLY_OPERATOR_SUBS` env allowlist.
 * Injects `ctx.adminSub`. Failure modes are distinguishable by the client:
 *
 * - UNAUTHORIZED 'admin auth required'    - no Bearer token at all
 * - UNAUTHORIZED 'admin id_token expired' - token verified structurally but exp
 *   passed (the Auth.js session outlives the ~10 min Minister id_token; the
 *   client should prompt a re-sign-in, NOT retry)
 * - UNAUTHORIZED 'invalid admin id_token' - signature / issuer / audience failed
 * - FORBIDDEN    'not an operator'        - verified sub not in the allowlist
 *   (also returned when the allowlist is unset/empty: fail closed, and do not
 *   reveal to a non-operator whether an allowlist is configured)
 */
export const adminProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.adminIdToken) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'admin auth required' });
  }
  let sub: string;
  try {
    ({ sub } = await ctx.verify(ctx.adminIdToken));
  } catch (err) {
    if (isExpiryError(err)) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'admin id_token expired' });
    }
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid admin id_token' });
  }
  if (!ctx.operatorSubs || ctx.operatorSubs.size === 0 || !ctx.operatorSubs.has(sub)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'not an operator' });
  }
  return next({ ctx: { ...ctx, adminSub: sub } });
});
