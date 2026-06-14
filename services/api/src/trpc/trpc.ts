import { initTRPC } from '@trpc/server';
import type { VerifiedIdentity } from '../minister/verify.js';

export type VerifyFn = (idToken: string) => Promise<VerifiedIdentity>;

export interface Context {
  verify: VerifyFn;
}

const t = initTRPC.context<Context>().create();
export const router = t.router;
export const publicProcedure = t.procedure;
