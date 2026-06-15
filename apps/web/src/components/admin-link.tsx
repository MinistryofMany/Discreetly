'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTRPC } from '@/lib/trpc';
import { Button } from '@/components/ui/button';

/**
 * Renders an Admin dashboard link only when admin.whoami succeeds.
 * Best-effort: hidden on error or while loading.
 */
export function AdminLink() {
  const trpc = useTRPC();
  // Gate on an authenticated session so the first whoami request carries the
  // Bearer id_token. Querying while unauthenticated guarantees a 401 (and, with
  // retry disabled, the admin link would never appear after sign-in).
  const { status } = useSession();
  const whoami = useQuery({
    ...trpc.admin.whoami.queryOptions(),
    retry: false,
    enabled: status === 'authenticated',
  });

  if (!whoami.data) return null;

  return (
    <Button asChild variant="outline" size="sm">
      <Link href="/admin">Admin</Link>
    </Button>
  );
}
