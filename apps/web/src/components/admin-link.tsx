'use client';

import Link from 'next/link';
import { useIsAdmin } from '@/components/shell/use-is-admin';
import { Button } from '@/components/ui/button';

/**
 * Renders an Admin dashboard link only for the operator. Shares the whoami
 * query (and its never-retry / expiry-preflight behavior) with the /admin
 * gate via useIsAdmin; hidden on every non-operator state.
 */
export function AdminLink() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return null;

  return (
    <Button asChild variant="outline" size="sm">
      <Link href="/admin">Admin</Link>
    </Button>
  );
}
