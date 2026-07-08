import Link from 'next/link';
import { IdentityPanel } from '@/components/identity-panel';
import { MinisterSub } from '@/components/minister-sub';
import { Button } from '@/components/ui/button';

export default function IdentityPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 md:py-12">
      <header className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Your identity</h1>
          <p className="text-sm text-muted-foreground">
            Create, unlock, back up, and manage your anonymous identity.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/">Back</Link>
        </Button>
      </header>
      <IdentityPanel />
      <MinisterSub className="mt-6 rounded-md border bg-card p-4" />
      <p className="mt-6 text-xs text-muted-foreground">
        To use the same identity on another device, export a backup here and
        import it there. Per-room device rotation is available from each room.
      </p>
    </div>
  );
}
