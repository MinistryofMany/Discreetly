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
      ? createWSClient({ url: API_WS_URL })
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
