'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { deriveRoomKey } from '@/lib/crypto-box';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Prompt for an AES room password and derive the per-room key (client-side). */
export function AesPanel({
  roomId,
  onKey,
}: {
  roomId: string;
  onKey: (key: CryptoKey) => void;
}) {
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    if (password.length === 0) {
      toast.error('Enter the room password.');
      return;
    }
    setBusy(true);
    try {
      const key = await deriveRoomKey(password, roomId);
      onKey(key);
      setPassword('');
      toast.success('Room key set. Messages will be decrypted locally.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <Label htmlFor="aes-password" className="text-sm">
        This room is encrypted. Enter the room password to read and send.
      </Label>
      <div className="flex gap-2">
        <Input
          id="aes-password"
          type="password"
          value={password}
          autoComplete="off"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          disabled={busy}
        />
        <Button onClick={submit} disabled={busy}>
          Unlock room
        </Button>
      </div>
    </div>
  );
}
