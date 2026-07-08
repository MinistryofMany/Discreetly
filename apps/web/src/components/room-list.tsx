'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { computeEligibility } from '@/lib/badges';
import { asPolicyNode, type PublicRoom } from '@/lib/room-types';
import { listLocalMemberships } from '@/lib/local-membership';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

function RoomCard({ room }: { room: PublicRoom }) {
  // Access verdicts belong to the server gate at join time. The card only says
  // whether the room is open or badge-gated; a client-side "you can join" from
  // decoded session badges was wrong for the per-room disclosure flow, so it
  // is intentionally gone.
  const eligibility = computeEligibility(asPolicyNode(room.accessPolicy), []);
  const open = eligibility.requiredScopes.length === 0;

  return (
    <Link href={`/rooms/${room.id}`} className="block focus:outline-none">
      <Card className="transition-colors hover:border-primary/50">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="text-lg">{room.name}</CardTitle>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              {room.pinned ? <Badge variant="secondary">pinned</Badge> : null}
              {room.encryption === 'AES' ? (
                <Badge variant="secondary">encrypted</Badge>
              ) : null}
              {room.persistence === 'EPHEMERAL' ? (
                <Badge variant="outline">ephemeral · no history</Badge>
              ) : (
                <Badge variant="outline">saved</Badge>
              )}
              {open ? (
                <Badge variant="success">open</Badge>
              ) : (
                <Badge variant="outline">badges required</Badge>
              )}
            </div>
          </div>
          {room.description ? (
            <CardDescription>{room.description}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-1.5 pt-0 text-xs text-muted-foreground">
          <span className="font-mono">{room.slug}</span>
          {eligibility.requiredScopes.map((scope) => (
            <Badge key={scope} variant="outline" className="font-normal">
              {scope.replace(/^badge:/, '')}
            </Badge>
          ))}
        </CardContent>
      </Card>
    </Link>
  );
}

function RoomGrid({ rooms }: { rooms: PublicRoom[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {rooms.map((room) => (
        <li key={room.id}>
          <RoomCard room={room} />
        </li>
      ))}
    </ul>
  );
}

export function RoomList() {
  const trpc = useTRPC();
  const rooms = useQuery(trpc.room.listPublic.queryOptions());

  // Locally-recorded memberships (written on join). Read in an effect so SSR
  // and the first client render agree (localStorage is browser-only).
  const [joinedIds, setJoinedIds] = React.useState<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    setJoinedIds(new Set(listLocalMemberships().map((m) => m.roomId)));
  }, []);

  if (rooms.isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }

  if (rooms.isError) {
    return (
      <p className="text-sm text-destructive">
        Failed to load rooms: {rooms.error.message}
      </p>
    );
  }

  if (!rooms.data || rooms.data.length === 0) {
    return <p className="text-sm text-muted-foreground">No public rooms yet.</p>;
  }

  const all = rooms.data as unknown as PublicRoom[];
  const joined = all.filter((r) => joinedIds.has(r.id));
  const others = joined.length > 0 ? all.filter((r) => !joinedIds.has(r.id)) : all;

  return (
    <div className="space-y-8">
      {joined.length > 0 ? (
        <section>
          <div className="mb-3 flex items-center gap-3">
            <h3 className="text-sm font-semibold text-muted-foreground">Joined</h3>
            <span className="h-px flex-1 bg-border" />
          </div>
          <RoomGrid rooms={joined} />
        </section>
      ) : null}
      {others.length > 0 ? (
        <section>
          {joined.length > 0 ? (
            <div className="mb-3 flex items-center gap-3">
              <h3 className="text-sm font-semibold text-muted-foreground">All rooms</h3>
              <span className="h-px flex-1 bg-border" />
            </div>
          ) : null}
          <RoomGrid rooms={others} />
        </section>
      ) : null}
    </div>
  );
}
