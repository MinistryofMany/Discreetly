'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { useMutation } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTRPC } from '@/lib/trpc';
import { useIdentity } from '@/lib/identity-context';
import { computeEligibility } from '@/lib/badges';
import { recordLocalMembership } from '@/lib/local-membership';
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
  roomToken,
  onJoined,
}: {
  room: PublicRoom;
  /**
   * The FRESH per-room id_token minted by the SDK disclosure flow, picked up by
   * the parent RoomView from the callback redirect. Used for the join INSTEAD of
   * the badge-free global session token. Null until a per-room disclosure has run
   * (open rooms / global login fall back to the session token).
   */
  roomToken: string | null;
  onJoined: () => void;
}) {
  const trpc = useTRPC();
  const { data: session } = useSession();
  const { identity } = useIdentity();
  const [deviceLabel, setDeviceLabel] = React.useState('');
  const [joining, setJoining] = React.useState(false);

  const joinMutation = useMutation(trpc.membership.join.mutationOptions());

  const policy = asPolicyNode(room.accessPolicy);

  // The id_token forwarded to the gate: prefer the fresh per-room token (carries
  // this room's disclosed badges), else the global session token.
  const idTokenForJoin = roomToken ?? session?.idToken ?? null;

  // Eligibility hint: evaluate the disclosed badges the UI knows about. With a
  // fresh per-room token we can't cheaply decode it client-side, so the hint uses
  // the global session badges; the server gate is authoritative on join.
  const eligibility = computeEligibility(policy, session?.ministerBadges ?? []);

  /**
   * Begin the per-room disclosure flow (Phase 3 / Path B). Navigates to the RP
   * "start join" route, which mints PKCE+state+nonce, persists flow state, and
   * redirects to Minister with the room's UNION scope + `minister_policy`.
   * Minister discloses one minimal satisfying set and mints a fresh per-room
   * id_token; the callback hands it back via `?roomAuthPickup`.
   *
   * Over-disclosure-to-RP: the authorize requests the room's UNION scope, but
   * Minister discloses only ONE minimal satisfying set (Phase 2), and the gate
   * sees only that token - never the whole wallet, never another room's badges.
   */
  function signInForRoom(): void {
    window.location.href = `/api/room-auth/start?roomId=${encodeURIComponent(room.id)}`;
  }

  async function handleJoin() {
    if (!idTokenForJoin) {
      toast.error('Sign in for this room first to disclose the required badges.');
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
        idToken: idTokenForJoin,
        identityCommitment: identity.commitment.toString(),
        deviceLabel: deviceLabel.trim() || undefined,
      })) as { ok: boolean; reason?: string; authorToken?: string };

      if (res.ok) {
        // Local join record: powers the rooms-home "Joined" section and the
        // composer's author link (operator moderation). The authorToken is
        // this membership's own random secret, returned only to the joiner.
        if (res.authorToken) recordLocalMembership(room.id, res.authorToken);
        toast.success('Joined the room.');
        onJoined();
      } else {
        toast.error(JOIN_REASONS[res.reason ?? ''] ?? `Join failed: ${res.reason}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Fail-closed expiry UX: the per-room id_token is short-lived (~10 min), so
      // an expired-token join error re-prompts a room-scoped sign-in instead of a
      // dead end.
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
                  variant={roomToken || eligibility.satisfied ? 'success' : 'outline'}
                >
                  {scope.replace(/^badge:/, '')}
                </Badge>
              ))}
            </div>
            {roomToken ? (
              <p className="text-xs text-emerald-600">
                Disclosed for this room (server re-verifies on join).
              </p>
            ) : !eligibility.satisfied ? (
              <p className="text-xs text-amber-600">
                Your session does not currently disclose the required badges. Sign
                in for this room to disclose them (the server is authoritative).
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

        {/*
          Two independent auth concepts under Path B:
            - the FRESH per-room id_token (`roomToken`), produced by the SDK
              disclosure flow, carries this room's disclosed badges;
            - the global Auth.js session token (`session.idToken`) is badge-free.
          The per-room flow does NOT create an Auth.js session, so the Join
          button is gated on having SOME usable id_token (per-room or session)
          plus an unlocked identity - not on the presence of a global session.
        */}
        {!idTokenForJoin ? (
          // No usable token yet: run the SDK disclosure flow for this room.
          // "Sign in with Minister" is reserved for the GLOBAL login; this is
          // the per-room badge disclosure.
          <Button onClick={signInForRoom}>Disclose badges for this room</Button>
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
              {(() => {
                // A gated room is only joinable once the badges are disclosed:
                // either a fresh per-room token exists or the session badges
                // already look sufficient. Until then the disclosure CTA is the
                // primary action and Join is inert - the old layout put a
                // always-denied Join first and users walked into policy-denied.
                const gated = eligibility.requiredScopes.length > 0;
                const canJoin = !gated || Boolean(roomToken) || eligibility.satisfied;
                return (
                  <>
                    {gated && !roomToken ? (
                      <Button variant={canJoin ? 'outline' : 'default'} onClick={signInForRoom}>
                        Disclose badges for this room
                      </Button>
                    ) : null}
                    <Button
                      variant={canJoin ? 'default' : 'outline'}
                      onClick={handleJoin}
                      disabled={joining || !identity || !canJoin}
                    >
                      {joining ? 'Joining...' : 'Join'}
                    </Button>
                  </>
                );
              })()}
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
