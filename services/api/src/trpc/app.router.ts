import { router } from './trpc.js';
import { roomRouter } from './room.router.js';
import { membershipRouter } from './membership.router.js';
import { messageRouter } from './message.router.js';

export const appRouter = router({
  room: roomRouter,
  membership: membershipRouter,
  message: messageRouter,
});

export type AppRouter = typeof appRouter;
