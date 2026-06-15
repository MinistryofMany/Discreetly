import { router, adminProcedure } from '../trpc/trpc.js';

export const adminRouter = router({
  whoami: adminProcedure.query(({ ctx }) => ({ adminSub: ctx.adminSub })),
});
