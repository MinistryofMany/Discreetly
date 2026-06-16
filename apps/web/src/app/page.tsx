import Link from 'next/link';
import { auth } from '@/auth';
import { SignInButton, SignOutButton } from '@/components/auth-buttons';
import { RoomList } from '@/components/room-list';
import { AdminLink } from '@/components/admin-link';
import { Button } from '@/components/ui/button';

export default async function HomePage() {
  const session = await auth();

  return (
    <main className="container mx-auto max-w-2xl px-4 py-12">
      <header className="mb-10 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Discreetly</h1>
          <p className="text-sm text-muted-foreground">
            Anonymous, rate-limited chat with verifiable credentials.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AdminLink />
          <Button asChild variant="outline">
            <Link href="/identity">Identity</Link>
          </Button>
          {session ? <SignOutButton /> : <SignInButton />}
        </div>
      </header>

      {session ? (
        <section className="mb-10 rounded-lg border bg-card p-4">
          <p className="text-sm">Signed in.</p>
          <p className="text-xs text-muted-foreground">
            You are anonymous - no account name is shown or shared.
          </p>
        </section>
      ) : (
        <section className="mb-10 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          Sign in with Minister to join rooms and send messages.
        </section>
      )}

      <section>
        <h2 className="mb-4 text-xl font-semibold">Public rooms</h2>
        <RoomList />
      </section>
    </main>
  );
}
