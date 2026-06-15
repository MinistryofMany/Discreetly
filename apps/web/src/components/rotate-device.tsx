'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { useMutation } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTRPC } from '@/lib/trpc';
import { useIdentity } from '@/lib/identity-context';
import { createIdentity, type AppIdentity } from '@/lib/identity';
import type { PublicRoom } from '@/lib/room-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

const ROTATE_REASONS: Record<string, string> = {
  banned: 'This identity is banned in the room.',
  'no-membership': 'No membership found for this room.',
  'old-leaf-not-found': 'Your current leaf was not found (already rotated?).',
  'new-leaf-exists': 'The new identity is already a member.',
  'no-room': 'Room not found.',
  'policy-denied': 'Your badges no longer satisfy this room.',
};

/**
 * Rotate the device identity for a single room: generate a fresh identity,
 * encrypt it under a password, and ask the server to swap the old leaf for the
 * new one (`membership.rotate`). The new identity becomes the active one.
 */
export function RotateDevice({
  room,
  onRotated,
}: {
  room: PublicRoom;
  onRotated: () => void;
}) {
  const trpc = useTRPC();
  const { data: session } = useSession();
  const { identity, persist } = useIdentity();
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const rotateMutation = useMutation(trpc.membership.rotate.mutationOptions());

  async function handleRotate() {
    if (!session?.idToken || !identity) {
      toast.error('Sign in and unlock an identity first.');
      return;
    }
    if (password.length === 0) {
      toast.error('Set a password to encrypt the new identity.');
      return;
    }
    setBusy(true);
    const next: AppIdentity = createIdentity();
    try {
      const res = (await rotateMutation.mutateAsync({
        roomId: room.id,
        idToken: session.idToken,
        oldIdentityCommitment: identity.commitment.toString(),
        newIdentityCommitment: next.commitment.toString(),
      })) as { ok: boolean; reason?: string };

      if (!res.ok) {
        toast.error(ROTATE_REASONS[res.reason ?? ''] ?? `Rotate failed: ${res.reason}`);
        return;
      }
      // Server swapped the leaf; persist the new identity locally and activate it.
      await persist(next, password);
      setPassword('');
      setOpen(false);
      toast.success('Identity rotated for this room.');
      onRotated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Rotate device
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate device identity</DialogTitle>
          <DialogDescription>
            Generates a new identity and swaps it into this room. Your old
            identity stops being a member here. Other devices/rooms are
            unaffected. Back up the new identity afterward.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rotate-password">New encryption password</Label>
          <Input
            id="rotate-password"
            type="password"
            value={password}
            autoComplete="off"
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleRotate} disabled={busy}>
            {busy ? 'Rotating...' : 'Rotate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
