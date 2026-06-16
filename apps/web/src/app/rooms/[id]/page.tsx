import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { RoomView } from '@/components/room-view';

export default async function RoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-4 py-4 md:py-6">
      <header className="mb-4 flex items-center justify-between gap-4">
        <Button asChild variant="ghost" size="sm">
          <Link href="/">&larr; Rooms</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/identity">Identity</Link>
        </Button>
      </header>
      <RoomView roomId={id} />
    </div>
  );
}
