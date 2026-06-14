import { router } from './trpc.js';
import { roomRouter } from './room.router.js';
import { membershipRouter } from './membership.router.js';

export const appRouter = router({
  room: roomRouter,
  membership: membershipRouter,
});

export type AppRouter = typeof appRouter;
