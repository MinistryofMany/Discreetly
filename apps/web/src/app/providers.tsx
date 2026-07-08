'use client';

import { useEffect, useRef, useState } from 'react';
import { SessionProvider, useSession } from 'next-auth/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { Toaster } from 'sonner';
import { TRPCProvider, makeTRPCClient } from '@/lib/trpc';
import { IdentityProvider } from '@/lib/identity-context';

/**
 * Best-effort HTTP status of a failed tRPC request. A tRPC-shaped error
 * carries it in `data.httpStatus`; a raw non-tRPC response (e.g. the API's
 * transport-layer 429 JSON) surfaces the fetch Response via `meta.response`.
 */
function httpStatusOf(error: unknown): number | undefined {
  if (!(error instanceof TRPCClientError)) return undefined;
  const dataStatus = (error.data as { httpStatus?: unknown } | undefined)?.httpStatus;
  if (typeof dataStatus === 'number') return dataStatus;
  const response = (error.meta as { response?: unknown } | undefined)?.response;
  if (response instanceof Response) return response.status;
  return undefined;
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Never retry client errors: a 401/403/404 will not heal by resending
        // (retrying auth failures is exactly the whoami-401 loop this replaces).
        // 429 = the API is shedding load - retry at most once, after a HARD
        // backoff (see retryDelay). Network/5xx get the standard 3 tries.
        retry(failureCount, error) {
          const status = httpStatusOf(error);
          if (status === 429) return failureCount < 1;
          if (status !== undefined && status >= 400 && status < 500) return false;
          return failureCount < 3;
        },
        retryDelay(attempt, error) {
          // 30-60s for a rate-limited request, else 1s/2s/4s... capped at 30s,
          // both with equal jitter so parallel queries do not re-fire in sync.
          const base =
            httpStatusOf(error) === 429
              ? 60_000
              : Math.min(1_000 * 2 ** attempt, 30_000);
          return base / 2 + Math.random() * (base / 2);
        },
      },
    },
  });
}

/**
 * Inner provider: lives under SessionProvider so it can read the session
 * id_token. A ref holds the latest token; the tRPC client reads it lazily on
 * every request, so the client is created once and never needs rebuilding.
 */
function TRPCWithSession({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();

  const idTokenRef = useRef<string | null>(null);
  idTokenRef.current = session?.idToken ?? null;

  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(() =>
    makeTRPCClient(() => idTokenRef.current),
  );

  // The id_token now travels only in the Authorization header, so it is not part
  // of any query key. When the session token changes (sign-in / sign-out / token
  // refresh) invalidate cached queries so gated reads (room.get / room.leaves)
  // are re-fetched with the new auth state instead of serving a stale result.
  const idToken = session?.idToken ?? null;
  useEffect(() => {
    void queryClient.invalidateQueries();
  }, [idToken, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <IdentityProvider>{children}</IdentityProvider>
      </TRPCProvider>
    </QueryClientProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <TRPCWithSession>{children}</TRPCWithSession>
      <Toaster position="top-center" richColors closeButton />
    </SessionProvider>
  );
}
