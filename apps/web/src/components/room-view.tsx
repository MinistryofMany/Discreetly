'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useTRPC } from '@/lib/trpc';
import { useIdentity } from '@/lib/identity-context';
import { rateCommitmentFor } from '@/lib/rln';
import type { PublicRoom } from '@/lib/room-types';
import type { FeedItem, RoomBroadcast } from '@/lib/broadcast-types';
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

  const roomQuery = useQuery(
    trpc.room.get.queryOptions({ id: roomId, idToken }),
  );
  const leavesQuery = useQuery(
    trpc.room.leaves.queryOptions({ id: roomId, idToken }),
  );

  const room = roomQuery.data as PublicRoom | undefined;
  const leavesData = leavesQuery.data as string[] | undefined;
  const leaves = React.useMemo(() => leavesData ?? [], [leavesData]);

  const [aesKey, setAesKey] = React.useState<CryptoKey | null>(null);
  const [items, setItems] = React.useState<FeedItem[]>([]);
  const seqRef = React.useRef(0);

  const appendBroadcast = React.useCallback((broadcast: RoomBroadcast) => {
    setItems((prev) => [
      ...prev,
      { key: `${Date.now()}-${seqRef.current++}`, broadcast },
    ]);
  }, []);

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

  // Membership: the user is joined iff their rateCommitment is in the leaf set.
  const joined = React.useMemo(() => {
    if (!identity || !room) return false;
    const rc = rateCommitmentFor(identity, BigInt(room.userMessageLimit)).toString();
    return leaves.includes(rc);
  }, [identity, room, leaves]);

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
    const isAccess = /forbidden|member|access|denied/i.test(msg);
    return (
      <div className="rounded-lg border bg-card p-6">
        <h2 className="mb-2 text-lg font-semibold">
          {isAccess ? 'Private room' : 'Unable to load room'}
        </h2>
        <p className="text-sm text-muted-foreground">
          {isAccess
            ? 'This is a private room. You must be a member to view it. Sign in and join to gain access.'
            : msg}
        </p>
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
          <ConnectionDot status={sub.status} />
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
        />
      </div>

      {!identity ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-muted-foreground">
            Unlock or create your identity to participate.
          </p>
          <IdentityPanel />
        </div>
      ) : !joined ? (
        <div className="mt-3">
          <JoinPanel
            room={room}
            onJoined={() => {
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

      {sub.status === 'error' ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-destructive">
          <span>Live feed disconnected.</span>
          <Button size="sm" variant="outline" onClick={() => sub.reset()}>
            Reconnect
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionDot({ status }: { status: string }) {
  const map: Record<string, { color: string; label: string }> = {
    idle: { color: 'bg-muted-foreground', label: 'idle' },
    connecting: { color: 'bg-amber-500', label: 'connecting' },
    pending: { color: 'bg-emerald-500', label: 'live' },
    error: { color: 'bg-destructive', label: 'disconnected' },
  };
  const s = map[status] ?? map.idle!;
  return (
    <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${s.color}`} />
      {s.label}
    </span>
  );
}
