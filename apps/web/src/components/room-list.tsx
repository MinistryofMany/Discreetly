'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTRPC } from '@/lib/trpc';
import { computeEligibility } from '@/lib/badges';
import { asPolicyNode, type PublicRoom } from '@/lib/room-types';
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
  const { data: session } = useSession();
  const badges = session?.ministerBadges ?? [];
  const eligibility = computeEligibility(asPolicyNode(room.accessPolicy), badges);
  const open = eligibility.requiredScopes.length === 0;

  return (
    <Link href={`/rooms/${room.id}`} className="block focus:outline-none">
      <Card className="transition-colors hover:border-primary/50">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="text-lg">{room.name}</CardTitle>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              {room.encryption === 'AES' ? (
                <Badge variant="secondary">encrypted</Badge>
              ) : null}
              {open ? (
                <Badge variant="success">open</Badge>
              ) : eligibility.satisfied ? (
                <Badge variant="success">you can join</Badge>
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

export function RoomList() {
  const trpc = useTRPC();
  const rooms = useQuery(trpc.room.listPublic.queryOptions());

  if (rooms.isLoading) {
    return (
      <div className="grid gap-3">
        {[0, 1, 2].map((i) => (
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

  return (
    <ul className="grid gap-3">
      {(rooms.data as unknown as PublicRoom[]).map((room) => (
        <li key={room.id}>
          <RoomCard room={room} />
        </li>
      ))}
    </ul>
  );
}
