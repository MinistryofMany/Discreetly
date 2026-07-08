'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/**
 * The signed-in user's own Minister pairwise sub with a copy control. This is
 * the value an operator puts in the API's DISCREETLY_OPERATOR_SUBS allowlist,
 * so it must be discoverable in the UI (/identity and /admin). It is the
 * caller's OWN sub - shown only to them.
 */
export function MinisterSub({ className }: { className?: string }) {
  const { data: session, status } = useSession();
  const sub = session?.sub ?? null;

  if (status !== 'authenticated' || !sub) return null;

  async function copySub() {
    if (!sub) return;
    try {
      await navigator.clipboard.writeText(sub);
      toast.success('Minister sub copied.');
    } catch {
      toast.error('Could not copy - select the value manually.');
    }
  }

  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground">Your Minister sub (this app)</p>
      <div className="mt-1 flex items-start gap-2">
        <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{sub}</code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => void copySub()}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}
