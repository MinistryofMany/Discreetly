'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { useSubscription, type TRPCSubscriptionStatus } from '@trpc/tanstack-react-query';
import { useTRPC, useWsExhausted, retryWsRealtime } from '@/lib/trpc';
import { useIsAdmin } from '@/components/shell/use-is-admin';
import { useIdentity } from '@/lib/identity-context';
import { rateCommitmentFor } from '@/lib/rln';
import { computeEligibility } from '@/lib/badges';
import { asPolicyNode, type PublicRoom } from '@/lib/room-types';
import type { ChatBroadcast, FeedItem, RoomBroadcast } from '@/lib/broadcast-types';
import { TOMBSTONE_MARKER } from '@/lib/broadcast-types';
import { MessageFeed } from '@/components/message-feed';
import { MessageComposer } from '@/components/message-composer';
import { JoinPanel } from '@/components/join-panel';
import { RotateDevice } from '@/components/rotate-device';
import { AesPanel } from '@/components/aes-panel';
import { IdentityPanel } from '@/components/identity-panel';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

export function RoomView({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const { data: session } = useSession();
  const { identity } = useIdentity();
  const idToken = session?.idToken ?? undefined;

  // room.get / room.leaves read the caller's id_token from the Authorization
  // header (set in makeTRPCClient), so it is never serialized into a query input
  // or URL. The WS subscription has no header, so it still passes idToken inline.
  const roomQuery = useQuery(trpc.room.get.queryOptions({ id: roomId }));
  const leavesQuery = useQuery(trpc.room.leaves.queryOptions({ id: roomId }));

  const room = roomQuery.data as PublicRoom | undefined;
  const leavesData = leavesQuery.data as string[] | undefined;
  const leaves = React.useMemo(() => leavesData ?? [], [leavesData]);

  // Persisted history backfill: seed the feed so a refresh or a late joiner sees
  // existing messages. Enabled once the room is readable. EPHEMERAL rooms return [].
  const historyQuery = useQuery({
    ...trpc.message.list.queryOptions({ roomId }),
    enabled: room !== undefined,
  });

  const [aesKey, setAesKey] = React.useState<CryptoKey | null>(null);
  const [items, setItems] = React.useState<FeedItem[]>([]);
  const seqRef = React.useRef(0);
  // Server message ids already in the feed, so backfill + live never double-render.
  const seenIdsRef = React.useRef<Set<string>>(new Set());

  // The FRESH per-room id_token from the SDK disclosure flow (Phase 3 / Path B).
  // The callback redirects here with `?roomAuthPickup=<id>`; pick the token up
  // ONCE (the endpoint deletes the DB row) and hand it to the JoinPanel for the
  // join. Done at the RoomView level - not inside JoinPanel - because JoinPanel
  // only mounts once an identity is unlocked, but the redirect lands with the
  // identity locked (in-memory state was lost across the OIDC round-trip).
  //
  // The token is stashed in `sessionStorage` keyed by roomId so it survives the
  // subsequent identity-unlock navigation (a full reload of /rooms/R that
  // remounts this component): the DB pickup row is single-use and already
  // deleted, so in-memory state alone would be lost on that reload. It is the
  // user's own token in their own browser - same trust boundary as the
  // in-memory session token - and is cleared once the join succeeds.
  const tokenKey = `roomToken:${roomId}`;
  const [roomToken, setRoomToken] = React.useState<string | null>(null);
  React.useEffect(() => {
    // Restore a token stashed by a prior pickup on this room (survives the
    // unlock reload).
    const stashed = window.sessionStorage.getItem(tokenKey);
    if (stashed) setRoomToken(stashed);

    const params = new URLSearchParams(window.location.search);
    const pickup = params.get('roomAuthPickup');
    const err = params.get('roomAuthError');
    const stripParam = (name: string) => {
      const url = new URL(window.location.href);
      url.searchParams.delete(name);
      window.history.replaceState(null, '', url.toString());
    };

    if (err) {
      toast.error('Disclosure failed. Please try signing in for this room again.');
      stripParam('roomAuthError');
      return;
    }
    if (!pickup) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/room-auth/token?pickup=${encodeURIComponent(pickup)}`);
        if (!res.ok) throw new Error(`pickup failed: ${res.status}`);
        const body = (await res.json()) as { idToken?: string };
        if (!cancelled && body.idToken) {
          window.sessionStorage.setItem(tokenKey, body.idToken);
          setRoomToken(body.idToken);
          toast.success('Badges disclosed for this room. Unlock your identity to join.');
        }
      } catch {
        if (!cancelled) {
          toast.error('Could not retrieve this room’s disclosure. Try signing in again.');
        }
      } finally {
        stripParam('roomAuthPickup');
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run once on mount: the pickup token is single-use and read from the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear the stashed per-room token once the join lands (single-use gate).
  const clearRoomToken = React.useCallback(() => {
    window.sessionStorage.removeItem(tokenKey);
    setRoomToken(null);
  }, [tokenKey]);

  const appendBroadcast = React.useCallback((broadcast: RoomBroadcast) => {
    // A tombstone re-renders an existing row in place (operator moderation); it
    // is never appended as a new feed item. Replace the matching message's
    // content with the marker and flag it deleted.
    if (broadcast.kind === 'tombstone') {
      setItems((prev) =>
        prev.map((it) =>
          it.broadcast.kind === 'message' && it.broadcast.id === broadcast.id
            ? {
                ...it,
                broadcast: {
                  ...it.broadcast,
                  content: TOMBSTONE_MARKER,
                  sessionColor: undefined,
                  deleted: true,
                },
              }
            : it,
        ),
      );
      return;
    }
    if (broadcast.kind === 'message') {
      if (seenIdsRef.current.has(broadcast.id)) return;
      seenIdsRef.current.add(broadcast.id);
    }
    const key =
      broadcast.kind === 'message'
        ? `m:${broadcast.id}`
        : `s:${Date.now()}-${seqRef.current++}`;
    setItems((prev) => [...prev, { key, broadcast }]);
  }, []);

  // Seed history (oldest-first) once it loads, before/independent of live data.
  // message.list returns newest-first, so reverse for chronological order.
  React.useEffect(() => {
    const history = historyQuery.data as ChatBroadcast[] | undefined;
    if (!history) return;
    const fresh = [...history].reverse().filter((m) => !seenIdsRef.current.has(m.id));
    if (fresh.length === 0) return;
    for (const m of fresh) seenIdsRef.current.add(m.id);
    setItems((prev) => [
      ...fresh.map((broadcast) => ({ key: `m:${broadcast.id}`, broadcast })),
      ...prev,
    ]);
  }, [historyQuery.data]);

  // Live subscription. Enabled only once the room is readable (loaded ok).
  const sub = useSubscription(
    trpc.message.subscribe.subscriptionOptions(
      { roomId, idToken },
      {
        enabled: room !== undefined,
        onData: (data) => appendBroadcast(data as RoomBroadcast),
        onError: (err) => {
          appendBroadcast({
            kind: 'system',
            roomId,
            text: `connection error: ${err.message}`,
            createdAt: new Date().toISOString(),
          });
        },
      },
    ),
  );

  // Operator-only moderation: the single platform operator may tombstone any
  // message. Non-operators never see the control and the API rejects them.
  const isOperator = useIsAdmin();
  const deleteMessageMut = useMutation(trpc.admin.deleteMessage.mutationOptions());
  const handleDeleteMessage = React.useCallback(
    (id: string) => {
      deleteMessageMut.mutate(
        { messageId: id },
        {
          // Optimistically tombstone the row in place; the server also publishes
          // a tombstone broadcast that reconciles other open feeds.
          onSuccess: () => appendBroadcast({ kind: 'tombstone', id, roomId }),
          onError: (err) =>
            toast.error(err instanceof Error ? err.message : 'Failed to remove message'),
        },
      );
    },
    [deleteMessageMut, appendBroadcast, roomId],
  );

  // Operator-only: ban the author of a message. The server resolves the
  // message's stored author link (the membership matched at write time from
  // the sender's own random author token); no token or nullifier ever reaches
  // this client. Messages without a link (pre-feature, ephemeral, or a client
  // that omitted it) fail with a clear error; the admin Bans tab's
  // raw-nullifier form is the manual fallback.
  const banAuthorMut = useMutation(trpc.admin.banMessageAuthor.mutationOptions());
  const handleBanAuthor = React.useCallback(
    (id: string) => {
      banAuthorMut.mutate(
        { messageId: id },
        {
          onSuccess: () => {
            toast.success('Author banned from this room.');
            void leavesQuery.refetch();
          },
          onError: (err) =>
            toast.error(err instanceof Error ? err.message : 'Failed to ban author'),
        },
      );
    },
    [banAuthorMut, leavesQuery],
  );

  // Membership: the user is joined iff their rateCommitment is in the leaf set.
  const joined = React.useMemo(() => {
    if (!identity || !room) return false;
    const rc = rateCommitmentFor(identity, BigInt(room.userMessageLimit)).toString();
    return leaves.includes(rc);
  }, [identity, room, leaves]);

  // Whether the room's policy requires badge disclosure at all (drives the
  // pre-unlock disclose CTA). requiredScopes depends only on the policy shape.
  const gated = React.useMemo(() => {
    if (!room) return false;
    return computeEligibility(asPolicyNode(room.accessPolicy), []).requiredScopes.length > 0;
  }, [room]);

  // Per-room SDK disclosure flow (same entry the JoinPanel uses).
  const signInForRoom = React.useCallback(() => {
    window.location.href = `/api/room-auth/start?roomId=${encodeURIComponent(roomId)}`;
  }, [roomId]);

  // Terminal realtime state: the WS client stopped re-dialing after exhausting
  // its reconnect budget (see lib/trpc.ts). Drives the Reconnect banner.
  const wsExhausted = useWsExhausted();

  if (roomQuery.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (roomQuery.isError) {
    const msg = roomQuery.error.message;
    // Branch on the typed tRPC error code rather than matching the message text.
    const code = (roomQuery.error as { data?: { code?: string } }).data?.code;
    const isAccess = code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
    return (
      <div className="rounded-lg border bg-card p-6">
        <h2 className="mb-2 text-lg font-semibold">
          {isAccess ? 'Private room' : 'Unable to load room'}
        </h2>
        <p className="text-sm text-muted-foreground">
          {isAccess ? 'This is a private room. Only members can view it.' : msg}
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/">Back to rooms</Link>
        </Button>
      </div>
    );
  }

  if (!room) return null;

  const aesNeeded = room.encryption === 'AES';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold tracking-tight">{room.name}</h1>
          {aesNeeded ? <Badge variant="secondary">encrypted</Badge> : null}
          {room.visibility === 'PRIVATE' ? (
            <Badge variant="outline">private</Badge>
          ) : null}
          {room.persistence === 'EPHEMERAL' ? (
            <Badge variant="outline">ephemeral · no history</Badge>
          ) : (
            <Badge variant="outline">saved</Badge>
          )}
          <ConnectionDot status={sub.status} exhausted={wsExhausted} />
        </div>
        {room.description ? (
          <p className="text-sm text-muted-foreground">{room.description}</p>
        ) : null}
      </div>

      {aesNeeded && !aesKey ? (
        <div className="mb-3">
          <AesPanel roomId={room.id} onKey={setAesKey} />
        </div>
      ) : null}

      <div className="min-h-[320px] flex-1">
        <MessageFeed
          items={items}
          aesKey={aesKey}
          loading={sub.status === 'connecting' || sub.status === 'idle'}
          ephemeral={room.persistence === 'EPHEMERAL'}
          onDelete={isOperator ? handleDeleteMessage : undefined}
          onBanAuthor={
            isOperator && room.persistence === 'PERSISTENT' ? handleBanAuthor : undefined
          }
        />
      </div>

      {!identity ? (
        <div className="mt-3 space-y-2">
          {gated && !roomToken && !joined ? (
            // P1.3: the per-room disclosure is a full-page OIDC redirect that
            // drops the in-memory identity anyway, so run it BEFORE unlocking:
            // disclose first (roomToken survives in sessionStorage), then
            // unlock once on return - instead of unlock → redirect → unlock.
            <div className="rounded-md border border-border bg-card p-3">
              <p className="text-sm text-muted-foreground">
                This room requires badge disclosure. Disclose first - then unlock your identity
                once when you are back.
              </p>
              <Button className="mt-2" onClick={signInForRoom}>
                Disclose badges for this room
              </Button>
            </div>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Unlock or create your identity to participate.
          </p>
          <IdentityPanel />
        </div>
      ) : !joined ? (
        <div className="mt-3">
          <JoinPanel
            room={room}
            roomToken={roomToken}
            onJoined={() => {
              clearRoomToken();
              void leavesQuery.refetch();
            }}
          />
        </div>
      ) : (
        <>
          <MessageComposer
            room={room}
            leaves={leaves}
            aesKey={aesKey}
            onSent={() => {
              void leavesQuery.refetch();
            }}
          />
          <div className="mt-1 flex justify-end">
            <RotateDevice
              room={room}
              onRotated={() => {
                void leavesQuery.refetch();
              }}
            />
          </div>
        </>
      )}

      {sub.status === 'error' || wsExhausted ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-destructive">
          <span>Live feed disconnected.</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              // Re-arm the WS reconnect budget (terminal after max attempts),
              // then restart the subscription; the next request lazily
              // re-dials the socket.
              retryWsRealtime();
              sub.reset();
            }}
          >
            Reconnect
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionDot({
  status,
  exhausted,
}: {
  status: TRPCSubscriptionStatus;
  exhausted: boolean;
}) {
  // Exhaustive over the tRPC subscription status union. 'pending' is the
  // connected/live state in @trpc/tanstack-react-query (verified against its
  // TRPCSubscriptionPendingResult type), so it maps to the green "live" dot.
  const map: Record<TRPCSubscriptionStatus, { color: string; label: string }> = {
    idle: { color: 'bg-muted-foreground', label: 'idle' },
    connecting: { color: 'bg-amber-500', label: 'connecting' },
    pending: { color: 'bg-emerald-500', label: 'live' },
    error: { color: 'bg-destructive', label: 'disconnected' },
  };
  // Reconnect budget exhausted: terminal disconnected, whatever the sub says.
  const s = exhausted ? map.error : map[status];
  return (
    <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${s.color}`} />
      {s.label}
    </span>
  );
}
