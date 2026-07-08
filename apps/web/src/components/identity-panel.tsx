'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { useIdentity } from '@/lib/identity-context';
import {
  backupToBlob,
  exportBackup,
  importBackup,
  WrongPasswordError,
  type AppIdentity,
} from '@/lib/identity';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Lock, LockOpen } from '@/components/icons';

function shortCommitment(c: bigint): string {
  const s = c.toString();
  return s.length <= 16 ? s : `${s.slice(0, 8)}...${s.slice(-8)}`;
}

function errMessage(e: unknown): string {
  if (e instanceof WrongPasswordError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function IdentityPanel() {
  const { identity, hasStored, create, unlock, lock, setUnlocked, persist, clear, refresh } =
    useIdentity();

  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [importing, setImporting] = React.useState<AppIdentity | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [revealCommitment, setRevealCommitment] = React.useState(false);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = React.useState(false);

  // Creating mints a SINGLE unrecoverable password (no reset path), so the
  // create flow demands a matching confirmation before minting.
  const creating = !identity && !hasStored;
  const confirmMismatch = creating && confirmPassword.length > 0 && confirmPassword !== password;

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleCreate() {
    if (password.length === 0) {
      toast.error('Choose a password to encrypt your identity.');
      return;
    }
    if (password !== confirmPassword) {
      toast.error('Passwords do not match. This password cannot be recovered - confirm it.');
      return;
    }
    setBusy(true);
    try {
      await create(password);
      setPassword('');
      setConfirmPassword('');
      toast.success('Identity created and encrypted on this device.');
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock() {
    setBusy(true);
    try {
      await unlock(password);
      setPassword('');
      toast.success('Identity unlocked.');
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    if (!identity) return;
    if (password.length === 0) {
      toast.error('Enter the password to encrypt the backup.');
      return;
    }
    setBusy(true);
    try {
      const backup = await exportBackup(identity, password);
      const url = URL.createObjectURL(backupToBlob(backup));
      const a = document.createElement('a');
      a.href = url;
      a.download = `discreetly-identity-${shortCommitment(identity.commitment)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setPassword('');
      toast.success('Backup downloaded.');
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function pickImportFile() {
    fileRef.current?.click();
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (password.length === 0) {
      toast.error('Enter the backup password first, then choose the file.');
      return;
    }
    setBusy(true);
    try {
      const text = await file.text();
      const id = await importBackup(text, password);
      setImporting(id);
      toast.success('Backup decrypted. Save it to this device to keep it.');
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveImported() {
    if (!importing) return;
    if (password.length === 0) {
      toast.error('Enter a password to encrypt the identity on this device.');
      return;
    }
    setBusy(true);
    try {
      await persist(importing, password);
      setImporting(null);
      setPassword('');
      toast.success('Imported identity saved to this device.');
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function handleClear() {
    setConfirmRemoveOpen(false);
    clear();
    toast.success('Identity removed from this device.');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          {identity ? (
            <LockOpen className="h-4 w-4 text-emerald-600" />
          ) : (
            <Lock className="h-4 w-4 text-muted-foreground" />
          )}
          Identity
        </CardTitle>
        <CardDescription>
          Your Semaphore identity is generated and encrypted entirely in this
          browser. The secret and password never leave your device.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {identity ? (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant="success">Unlocked</Badge>
            </div>
            <div className="flex items-start gap-2">
              <p className="break-all font-mono text-xs text-muted-foreground">
                commitment:{' '}
                {revealCommitment ? identity.commitment.toString() : '•'.repeat(16)}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 shrink-0 px-2 text-xs"
                onClick={() => setRevealCommitment((v) => !v)}
              >
                {revealCommitment ? 'Hide' : 'Reveal'}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {hasStored
              ? 'An encrypted identity is stored on this device. Unlock it to join rooms and send messages.'
              : 'No identity yet. Create one to participate.'}
          </p>
        )}

        <div className="space-y-2">
          <Label htmlFor="identity-password">Password</Label>
          <div className="flex gap-2">
            <Input
              id="identity-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              autoComplete="off"
              placeholder={hasStored && !identity ? 'Unlock password' : 'Encryption password'}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 px-2 text-xs"
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? 'Hide' : 'Show'}
            </Button>
          </div>
        </div>

        {creating ? (
          <div className="space-y-2">
            <Label htmlFor="identity-password-confirm">Confirm password</Label>
            <Input
              id="identity-password-confirm"
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              autoComplete="off"
              placeholder="Repeat the password"
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={busy}
            />
            {confirmMismatch ? (
              <p className="text-xs text-destructive">Passwords do not match.</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                There is no reset. If you lose this password, the identity is gone.
              </p>
            )}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {identity ? (
            <>
              <Button variant="outline" onClick={lock} disabled={busy}>
                Lock
              </Button>
              <Button variant="outline" onClick={handleExport} disabled={busy}>
                Export backup
              </Button>
              <Button
                variant="destructive"
                onClick={() => setConfirmRemoveOpen(true)}
                disabled={busy}
              >
                Remove from device
              </Button>
            </>
          ) : (
            <>
              {hasStored ? (
                <Button onClick={handleUnlock} disabled={busy}>
                  Unlock
                </Button>
              ) : (
                <Button onClick={handleCreate} disabled={busy || confirmMismatch}>
                  Create identity
                </Button>
              )}
              <Button variant="outline" onClick={pickImportFile} disabled={busy}>
                Import backup
              </Button>
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={onImportFile}
          />
        </div>

        <Dialog open={confirmRemoveOpen} onOpenChange={setConfirmRemoveOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Remove identity from this device?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              This cannot be undone without a backup. Rooms joined with this identity become
              unreachable from this device.
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button variant="destructive" onClick={handleClear}>
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {importing ? (
          <div className="space-y-2 rounded-md border border-dashed p-3 text-sm">
            <p>
              Imported identity{' '}
              <span className="font-mono text-xs">
                {shortCommitment(importing.commitment)}
              </span>
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={saveImported} disabled={busy}>
                Save to this device
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setImporting(null)}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
