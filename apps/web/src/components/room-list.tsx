'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';

// Non-secret room fields returned by `room.listPublic` (see PUBLIC_ROOM_FIELDS
// in services/api). Typed locally to avoid instantiating the full AppRouter
// output type, whose recursive Json policy field trips TS2589.
type PublicRoom = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
};
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function RoomList() {
  const trpc = useTRPC();
  const rooms = useQuery(trpc.room.listPublic.queryOptions());

  if (rooms.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading rooms...</p>;
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
      {rooms.data.map((room: PublicRoom) => (
        <li key={room.id}>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{room.name}</CardTitle>
              {room.description ? (
                <CardDescription>{room.description}</CardDescription>
              ) : null}
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {room.slug}
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
