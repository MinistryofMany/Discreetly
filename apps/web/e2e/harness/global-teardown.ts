/** Playwright global teardown: stop all e2e servers started in global setup. */
import { disconnectPrisma } from './db.js';
import type { RunningServers } from './servers.js';

declare global {
  // eslint-disable-next-line no-var
  var __E2E_SERVERS__: RunningServers | undefined;
}

export default async function globalTeardown(): Promise<void> {
  await disconnectPrisma();
  if (globalThis.__E2E_SERVERS__) {
    await globalThis.__E2E_SERVERS__.stop();
    globalThis.__E2E_SERVERS__ = undefined;
  }
}
