'use client';

import {
  createTRPCClient,
  createWSClient,
  httpBatchLink,
  loggerLink,
  splitLink,
  wsLink,
} from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import type { AppRouter } from '@discreetly/api';

// React context + hooks (useTRPC / TRPCProvider) for the AppRouter.
export const { TRPCProvider, useTRPC, useTRPCClient } =
  createTRPCContext<AppRouter>();

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';
const API_WS_URL =
  process.env.NEXT_PUBLIC_API_WS_URL ?? 'ws://localhost:3002';

// --- WebSocket reconnect backoff -------------------------------------------
// tRPC's built-in `exponentialBackoff` returns 0ms for attempt 0 and resets its
// attempt counter whenever a socket briefly opens before dying. When the endpoint
// accepts the handshake and then immediately closes (e.g. an edge/tunnel that
// completes the upgrade but does not forward WS frames to the API), that reset
// collapses the backoff into a 0ms tight loop that hammers the endpoint until the
// browser reports "Insufficient resources" and Cloudflare starts 429ing the
// handshake. We supply our own retry policy with a monotonic failure counter that
// only resets after a connection has stayed open long enough to be considered
// healthy, so a flapping socket keeps escalating instead of resetting.
const WS_RECONNECT_MIN_MS = 1_000; // floor for the first retry
const WS_RECONNECT_MAX_MS = 30_000; // ceiling on the reconnect interval
const WS_MAX_RECONNECT_ATTEMPTS = 10; // give up (stop the storm) after this many
const WS_STABLE_CONNECTION_MS = 10_000; // "healthy" once open this long → reset count

/**
 * Create a tRPC WS client whose reconnects use exponential backoff with equal
 * jitter, a hard ceiling on the interval, and a max-attempt cap. Unlike the
 * library default, the attempt counter is owned here and is only cleared once a
 * connection survives `WS_STABLE_CONNECTION_MS`, so an open-then-immediately-close
 * flap does not reset the backoff to 0.
 */
function createBackoffWSClient(url: string) {
  let failureCount = 0;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  // Assigned synchronously by createWSClient below; the callbacks that read it
  // only fire after that assignment.
  let client: ReturnType<typeof createWSClient> | undefined;

  const clearStableTimer = () => {
    if (stableTimer !== null) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  };

  client = createWSClient({
    url,
    // The library passes its own (unreliable) attemptIndex; we ignore it and use
    // our monotonic failureCount, which is incremented in onClose before this runs.
    retryDelayMs: () => {
      const n = Math.max(1, failureCount);
      const base = Math.min(WS_RECONNECT_MIN_MS * 2 ** (n - 1), WS_RECONNECT_MAX_MS);
      // Equal jitter: delay in [base/2, base]. Never 0, never above the ceiling.
      const delay = base / 2 + Math.random() * (base / 2);
      return Math.min(delay, WS_RECONNECT_MAX_MS);
    },
    onOpen: () => {
      // The socket is open, but a flapping endpoint may close it again right away.
      // Only treat it as healthy (and reset backoff) once it stays open a while.
      clearStableTimer();
      stableTimer = setTimeout(() => {
        failureCount = 0;
        stableTimer = null;
      }, WS_STABLE_CONNECTION_MS);
    },
    onClose: () => {
      clearStableTimer();
      failureCount += 1;
      if (failureCount >= WS_MAX_RECONNECT_ATTEMPTS) {
        // Stop hammering a dead endpoint. This halts the reconnect loop; a page
        // reload (or a new client) restarts it. Better a silent realtime outage
        // than a request storm that gets the whole origin rate-limited.
        client?.close();
      }
    },
  });

  return client;
}

/**
 * Build a tRPC client. `getIdToken` returns the current Minister id_token (or
 * null) so each HTTP batch attaches `Authorization: Bearer <id_token>` when a
 * session exists. The API treats the header as optional (admin procedures use
 * it; it is harmless elsewhere).
 */
export function makeTRPCClient(getIdToken: () => string | null) {
  // The WS client only exists in the browser.
  const wsClient =
    typeof window !== 'undefined'
      ? createBackoffWSClient(API_WS_URL)
      : null;

  return createTRPCClient<AppRouter>({
    links: [
      loggerLink({
        enabled: (op) =>
          process.env.NODE_ENV === 'development' ||
          (op.direction === 'down' && op.result instanceof Error),
      }),
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: wsClient
          ? wsLink<AppRouter>({ client: wsClient })
          : httpBatchLink({ url: API_URL, methodOverride: 'POST' }),
        false: httpBatchLink({
          url: API_URL,
          // Force POST for queries too. The default GET serializes query input
          // into the URL, which would leak the Bearer id_token (when passed as
          // an input) into access logs / history / Referer. POST keeps inputs in
          // the request body and the token in the Authorization header only.
          methodOverride: 'POST',
          headers() {
            const idToken = getIdToken();
            return idToken ? { Authorization: `Bearer ${idToken}` } : {};
          },
        }),
      }),
    ],
  });
}
