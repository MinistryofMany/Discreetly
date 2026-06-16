'use client';

import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTRPC } from '@/lib/trpc';

/**
 * True when the current session is an admin. Mirrors AdminLink's gating:
 * only queries once authenticated (so the Bearer id_token is attached) and
 * treats any error / loading state as "not admin".
 */
export function useIsAdmin(): boolean {
  const trpc = useTRPC();
  const { status } = useSession();
  const whoami = useQuery({
    ...trpc.admin.whoami.queryOptions(),
    retry: false,
    enabled: status === 'authenticated',
  });
  return Boolean(whoami.data);
}
