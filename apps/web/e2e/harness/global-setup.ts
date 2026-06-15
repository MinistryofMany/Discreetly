/**
 * Playwright global setup: prepare the isolated e2e database, build the web app
 * with e2e env inlined, then start the mock OIDC issuer, the API, and the web
 * server. The running-servers handle is stashed on globalThis for teardown.
 */
import { prepareDatabase, disconnectPrisma } from './db.js';
import { buildWeb, startServers, type RunningServers } from './servers.js';

declare global {
  // eslint-disable-next-line no-var
  var __E2E_SERVERS__: RunningServers | undefined;
}

export default async function globalSetup(): Promise<void> {
  await prepareDatabase();
  await disconnectPrisma(); // setup-only connection; specs reopen their own.
  // E2E_REUSE: assume the harness servers are already running (fast local
  // iteration). Skips the build + spawn and leaves teardown to the operator.
  if (process.env.E2E_REUSE === '1') return;
  await buildWeb();
  globalThis.__E2E_SERVERS__ = await startServers();
}
