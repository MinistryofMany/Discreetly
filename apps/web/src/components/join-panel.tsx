'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { signIn } from 'next-auth/react';
import { useMutation } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTRPC } from '@/lib/trpc';
import { useIdentity } from '@/lib/identity-context';
import { computeEligibility } from '@/lib/badges';
import { asPolicyNode, type PublicRoom } from '@/lib/room-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const JOIN_REASONS: Record<string, string> = {
  banned: 'This identity is banned from the room.',
  'device-limit': 'This room has reached its device limit for you.',
  'already-on-device': 'This device is already a member of the room.',
  'policy-denied':
    'Your disclosed badges do not satisfy this room. Re-sign in to disclose the required badges.',
  'no-room': 'Room not found.',
};

export function JoinPanel({
  room,
  onJoined,
}: {
  room: PublicRoom;
  onJoined: () => void;
}) {
  const trpc = useTRPC();
  const { data: session } = useSession();
  const { identity } = useIdentity();
  const [deviceLabel, setDeviceLabel] = React.useState('');
  const [joining, setJoining] = React.useState(false);

  const joinMutation = useMutation(trpc.membership.join.mutationOptions());

  const eligibility = computeEligibility(
    asPolicyNode(room.accessPolicy),
    session?.ministerBadges ?? [],
  );

  async function handleJoin() {
    if (!session?.idToken) {
      toast.error('Sign in with Minister first.');
      return;
    }
    if (!identity) {
      toast.error('Create or unlock an identity first.');
      return;
    }
    setJoining(true);
    try {
      const res = (await joinMutation.mutateAsync({
        roomId: room.id,
        idToken: session.idToken,
        identityCommitment: identity.commitment.toString(),
        deviceLabel: deviceLabel.trim() || undefined,
      })) as { ok: boolean; reason?: string };

      if (res.ok) {
        toast.success('Joined the room.');
        onJoined();
      } else {
        toast.error(JOIN_REASONS[res.reason ?? ''] ?? `Join failed: ${res.reason}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setJoining(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Join this room</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {eligibility.requiredScopes.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Required badges:</p>
            <div className="flex flex-wrap gap-1.5">
              {eligibility.requiredScopes.map((scope) => (
                <Badge
                  key={scope}
                  variant={eligibility.satisfied ? 'success' : 'outline'}
                >
                  {scope.replace(/^badge:/, '')}
                </Badge>
              ))}
            </div>
            {!eligibility.satisfied ? (
              <p className="text-xs text-amber-600">
                Your session does not currently disclose the required badges. The
                server is authoritative - try re-signing in to disclose them.
              </p>
            ) : (
              <p className="text-xs text-emerald-600">
                Your disclosed badges look sufficient (server re-verifies on
                join).
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This room is open - no badges required.
          </p>
        )}

        {!session ? (
          <Button onClick={() => signIn('minister')}>Sign in with Minister</Button>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="device-label">Device label (optional)</Label>
              <Input
                id="device-label"
                value={deviceLabel}
                placeholder="e.g. laptop"
                onChange={(e) => setDeviceLabel(e.target.value)}
                disabled={joining}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleJoin} disabled={joining || !identity}>
                {joining ? 'Joining...' : 'Join'}
              </Button>
              {eligibility.requiredScopes.length > 0 && !eligibility.satisfied ? (
                <Button variant="outline" onClick={() => signIn('minister')}>
                  Re-sign in to disclose badges
                </Button>
              ) : null}
            </div>
            {!identity ? (
              <p className="text-xs text-amber-600">
                Unlock or create an identity (top-right) before joining.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
