'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { signIn } from 'next-auth/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTRPC } from '@/lib/trpc';
import { useIdentity } from '@/lib/identity-context';
import {
  computeEligibility,
  scopesToRequestForRoom,
  roomScopeOptions,
  roomHasBranchChoice,
  defaultRoomBranch,
} from '@/lib/badges';
import { badgeScopes } from '@minister/client/badges';
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

  const policy = asPolicyNode(room.accessPolicy);

  // Authoritative durable proven set for this user (server verifies the id_token
  // from the Authorization header and keys on the verified sub). Used to compute
  // the join "delta" so we request only genuinely-new badges. Empty when signed
  // out / token invalid (fail closed: request everything the room needs).
  const provenQuery = useQuery({
    ...trpc.membership.provenBadges.queryOptions(),
    enabled: Boolean(session?.idToken),
  });
  const provenTypes = provenQuery.data?.badgeTypes ?? [];

  const eligibility = computeEligibility(policy, session?.ministerBadges ?? []);

  // INTERIM - Phase 2 moves OR/threshold selection to Minister. The user may pick
  // a non-default branch here; `null` means "use the cheapest default".
  const branchChoice = roomHasBranchChoice(policy);
  const [chosenBranch, setChosenBranch] = React.useState<string[] | null>(null);
  const branchOptions = React.useMemo(() => roomScopeOptions(policy), [policy]);

  /**
   * Model 2b: trigger a room-scoped Minister sign-in that requests this room's
   * FULL required badge set (a single chosen branch), via the THIRD `signIn` arg.
   * NOT the delta - the owner chose to re-request already-proven badges each time
   * so the live token presented to the gate always carries the room's complete
   * set. A chosen OR-branch overrides the cheapest default. Fails closed to base
   * scopes (server denies) on a malformed/unsatisfiable policy.
   *
   * Over-disclosure-to-RP invariant: the requested badges are exactly one branch
   * of THIS room's policy, never the whole wallet or another room's badges.
   */
  function signInForRoom(): void {
    let scope: string[];
    if (chosenBranch) {
      // Honor the user's explicit OR-branch pick - the FULL branch (2b), not a
      // delta. `provenTypes` does not subtract here.
      scope = ['openid', 'profile', ...badgeScopes(chosenBranch)];
    } else {
      scope = scopesToRequestForRoom(policy, provenTypes);
    }
    void signIn('minister', { redirectTo: `/rooms/${room.id}` }, { scope: scope.join(' ') });
  }

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
        // Refresh the proven set: the join just recorded the disclosed types.
        void provenQuery.refetch();
        onJoined();
      } else {
        toast.error(JOIN_REASONS[res.reason ?? ''] ?? `Join failed: ${res.reason}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Fail-closed expiry UX: the forwarded id_token is short-lived (~10 min)
      // with no refresh, so an expired-token join error re-prompts a room-scoped
      // sign-in (same delta scopes) instead of a dead end.
      if (/expired|exp\b/i.test(message)) {
        toast.error('Your sign-in expired. Re-authenticating for this room...');
        signInForRoom();
      } else {
        toast.error(message);
      }
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

            {/* INTERIM - Phase 2 moves OR-selection to Minister. For a room that
                accepts a CHOICE of proofs, let the user pick which one to disclose
                (default: the cheapest for them). */}
            {branchChoice ? (
              <div className="space-y-1 rounded border border-dashed p-2">
                <p className="text-xs text-muted-foreground">
                  This room accepts one of several proofs. Choose which to disclose
                  (interim - this selection will move into Minister consent):
                </p>
                <div className="flex flex-wrap gap-2">
                  {branchOptions.map((opt) => {
                    const key = opt.join('+');
                    const isDefault =
                      JSON.stringify(opt) === JSON.stringify(defaultRoomBranch(policy, provenTypes));
                    const selected = chosenBranch
                      ? JSON.stringify(chosenBranch) === JSON.stringify(opt)
                      : isDefault;
                    return (
                      <Button
                        key={key}
                        size="sm"
                        variant={selected ? 'default' : 'outline'}
                        onClick={() => setChosenBranch(opt)}
                      >
                        {opt.length === 0 ? 'no badges' : opt.join(' + ')}
                      </Button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This room is open - no badges required.
          </p>
        )}

        {!session ? (
          // Room-scoped sign-in: request only this room's required badges (the
          // delta), not the whole wallet. A non-room sign-in lives in the header.
          <Button onClick={signInForRoom}>Sign in with Minister</Button>
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
                <Button variant="outline" onClick={signInForRoom}>
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
