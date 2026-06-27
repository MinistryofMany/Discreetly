'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { signIn } from 'next-auth/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTRPC } from '@/lib/trpc';
import { useIdentity } from '@/lib/identity-context';
import { computeEligibility, scopesToRequestForRoom } from '@/lib/badges';
import { encodeMinisterPolicy } from '@/lib/minister-policy';
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
  // from the Authorization header and keys on the verified sub). Refreshed after
  // a successful join so downstream consumers stay current.
  const provenQuery = useQuery({
    ...trpc.membership.provenBadges.queryOptions(),
    enabled: Boolean(session?.idToken),
  });

  const eligibility = computeEligibility(policy, session?.ministerBadges ?? []);

  /**
   * Trigger a room-scoped Minister sign-in (via the THIRD `signIn` arg) that
   * requests the UNION of this room's required badge types as `scope` AND sends
   * the room's policy AST as the `minister_policy` param. Minister - which knows
   * each type's anonymity-set size - selects the minimal satisfying subset to
   * disclose (and lets the user override at consent); Discreetly no longer picks
   * an OR/threshold branch itself. Fails closed to base scopes (server denies)
   * on a malformed/unsatisfiable policy.
   *
   * Over-disclosure-to-RP invariant: even though the union scope lists every
   * candidate type, Minister discloses only one satisfying subset of THIS room's
   * policy - never the whole wallet, never another room's badges. If the policy
   * cannot be encoded, the `minister_policy` param is omitted (fail-closed) and
   * Minister falls back to per-scope disclosure; the server gate stays
   * authoritative.
   */
  function signInForRoom(): void {
    const scope = scopesToRequestForRoom(policy);
    const ministerPolicy = encodeMinisterPolicy(policy);
    const params: Record<string, string> = { scope: scope.join(' ') };
    if (ministerPolicy !== null) params.minister_policy = ministerPolicy;
    void signIn('minister', { redirectTo: `/rooms/${room.id}` }, params);
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
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This room is open - no badges required.
          </p>
        )}

        {!session ? (
          // Room-scoped sign-in: request this room's required badge types (and its
          // policy, so Minister selects the minimal satisfying set), not the whole
          // wallet. A non-room sign-in lives in the header.
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
