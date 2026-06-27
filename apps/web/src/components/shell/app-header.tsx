'use client';

import Link from 'next/link';
import { signIn, signOut, useSession } from 'next-auth/react';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';

function AuthControl() {
  const { status } = useSession();

  if (status === 'loading') {
    return <div className="h-9 w-20 animate-pulse rounded-md bg-muted" />;
  }

  if (status === 'authenticated') {
    return (
      <Button size="sm" variant="outline" onClick={() => signOut()}>
        Sign out
      </Button>
    );
  }

  // Global sign-in: intentionally badge-free (provider default is
  // `['openid','profile']`). Per-room badge scopes are requested at join.
  return (
    <Button size="sm" onClick={() => signIn('minister')}>
      Sign in
    </Button>
  );
}

export function AppHeader() {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border bg-[hsl(180_6%_9%)] px-3 md:px-4">
      <Link
        href="/"
        aria-label="Discreetly home"
        className="rounded-sm outline-none ring-ring transition-opacity hover:opacity-80 focus-visible:ring-2"
      >
        <Logo />
      </Link>

      <div className="flex items-center gap-3">
        <span className="hidden font-display text-sm text-primary sm:inline">
          Beta V3
        </span>
        <AuthControl />
      </div>
    </header>
  );
}
