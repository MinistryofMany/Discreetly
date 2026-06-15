'use client';

import { signIn, signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';

export function SignInButton() {
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
