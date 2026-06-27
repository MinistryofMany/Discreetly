'use client';

import Link from 'next/link';
import { signIn, useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Mask } from '@/components/icons';

/** Hero call-to-action, ported from the old landing page's primary button. */
export function LandingCta() {
  const { status } = useSession();

  return (
    <div className="mt-8 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
      {status === 'authenticated' ? (
        <Button asChild size="lg" className="min-w-[13rem]">
          <Link href="/identity">
            <Mask className="h-5 w-5" />
            Manage identity
          </Link>
        </Button>
      ) : (
        // Global sign-in: intentionally badge-free (provider default is
        // `['openid','profile']`). Per-room badge scopes are requested at join.
        <Button
          size="lg"
          className="min-w-[13rem]"
          onClick={() => signIn('minister')}
        >
          <Mask className="h-5 w-5" />
          Sign in with Minister
        </Button>
      )}
    </div>
  );
}
