'use client';

import { useEffect, useRef, useState } from 'react';
import { SessionProvider, useSession } from 'next-auth/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { TRPCProvider, makeTRPCClient } from '@/lib/trpc';
import { IdentityProvider } from '@/lib/identity-context';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false },
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
