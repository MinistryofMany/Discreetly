'use client';

import { signIn, signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';

export function SignInButton() {
  // Global sign-in: intentionally badge-free. With the provider default now
  // `['openid','profile']` (see auth.ts), this discloses NO badges. Per-room
  // badge scopes are requested at join (join-panel.tsx), not here.
  return (
    <Button onClick={() => signIn('minister')}>Sign in with Minister</Button>
  );
}

export function SignOutButton() {
  return (
    <Button variant="outline" onClick={() => signOut()}>
      Sign out
    </Button>
  );
}
