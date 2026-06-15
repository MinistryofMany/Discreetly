'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { Button } from '@/components/ui/button';

/**
 * Renders an Admin dashboard link only when admin.whoami succeeds.
 * Best-effort: hidden on error or while loading.
 */
export function AdminLink() {
  const trpc = useTRPC();
  const whoami = useQuery({
    ...trpc.admin.whoami.queryOptions(),
    retry: false,
  });

  if (!whoami.data) return null;

  return (
    <Button asChild variant="outline" size="sm">
      <Link href="/admin">Admin</Link>
    </Button>
  );
}
