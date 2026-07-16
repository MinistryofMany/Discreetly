'use client';

import * as React from 'react';
import { useIdentity } from '@/lib/identity-context';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Lock, LockOpen } from '@/components/icons';

/**
 * Read-only status of this account's anonymous identity. There is no password,
 * no vault, and no create/unlock/export/import: the identity is DERIVED per room
 * from the Ministry branch delivered at sign-in (see `identity.ts`), the same on
 * every device holding the user's root. This panel only reports whether that
 * branch is present; there is no single commitment to show (it is per-room).
 */
export function IdentityPanel() {
  const { hasBranch, ready } = useIdentity();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          {hasBranch ? (
            <LockOpen className="h-4 w-4 text-emerald-600" />
          ) : (
            <Lock className="h-4 w-4 text-muted-foreground" />
          )}
          Anonymous identity
        </CardTitle>
        <CardDescription>
          Your identity is derived from your Ministry account on this device and
          is different in every room, so your rooms cannot be linked. There is
          nothing to back up here - your Ministry key is the backup.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {!ready ? (
          <p className="text-muted-foreground">Checking your identity…</p>
        ) : hasBranch ? (
          <div className="flex items-center gap-2">
            <Badge variant="success">Ready</Badge>
            <span className="text-muted-foreground">
              Set up on this device. Rooms derive their identity automatically.
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Badge variant="outline">Not set up</Badge>
            <span className="text-muted-foreground">
              Sign in with Minister to set up your anonymous identity on this
              device.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
