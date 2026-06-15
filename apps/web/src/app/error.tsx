'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';

/**
 * App Router error boundary. A render-time throw anywhere in the segment tree
 * lands here instead of a blank screen. `reset` re-renders the failed segment.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // Surface the error for diagnostics; Next strips messages from the client in
    // production, so the digest is the correlation key to the server logs.
    console.error(error);
  }, [error]);

  return (
    <main className="container mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 px-4 py-10 text-center">
      <h1 className="text-2xl font-bold tracking-tight">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        An unexpected error occurred while rendering this page. You can try again,
        or head back to the rooms list.
      </p>
      {error.digest ? (
        <p className="font-mono text-xs text-muted-foreground">Ref: {error.digest}</p>
      ) : null}
      <div className="flex gap-2">
        <Button onClick={() => reset()}>Try again</Button>
        <Button variant="outline" onClick={() => (window.location.href = '/')}>
          Back to rooms
        </Button>
      </div>
    </main>
  );
}
