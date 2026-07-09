'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { signIn } from 'next-auth/react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc';
import { useOperatorStatus } from '@/components/shell/use-is-admin';
import { MinisterSub } from '@/components/minister-sub';
import {
  type AdminRoom,
  type AdminMembership,
  type AuditLogRow,
  asAdminRooms,
  asAdminMemberships,
  asAuditLogRows,
  asBanRows,
} from '@/lib/admin-types';
import { nameChangeUpdate } from '@/lib/admin-room-form';
import {
  type PolicyBuilderNode,
  buildAndValidate,
  makeOpenPolicy,
  deserializeNode,
} from '@/lib/policy-builder';
import { PolicyBuilder } from '@/components/admin/policy-builder';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ---- Shared admin mutation helper -------------------------------------------

/**
 * Wrap an admin mutation so every call invalidates the membership list, toasts a
 * success message, and surfaces failures uniformly. Returns a `run` that awaits
 * the mutation and a `busy` flag keyed to the in-flight call.
 *
 * `mutationOptions` is the object returned by a tRPC `*.mutationOptions()` call.
 * The input type is inferred from the options' `mutationFn`; the result/error
 * types are irrelevant to the caller, so the options are accepted as-is.
 */
function useAdminMutation<
  TOptions extends { mutationFn?: (input: never, ...rest: never[]) => Promise<unknown> },
>(mutationOptions: TOptions, successMsg: string) {
  type TInput = TOptions extends {
    mutationFn?: (input: infer I, ...rest: never[]) => Promise<unknown>;
  }
    ? I
    : never;
  const queryClient = useQueryClient();
  // The options carry their own precise error/result types; the helper only
  // needs `mutateAsync(input)`, so cast through the loosely-typed mutate fn.
  const mutation = useMutation(mutationOptions as Parameters<typeof useMutation>[0]);
  const [busy, setBusy] = React.useState(false);

  const run = React.useCallback(
    async (input: TInput): Promise<boolean> => {
      setBusy(true);
      try {
        await (mutation.mutateAsync as (i: TInput) => Promise<unknown>)(input);
        void queryClient.invalidateQueries({ queryKey: [['admin', 'room', 'memberships']] });
        toast.success(successMsg);
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Action failed');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [mutation, queryClient, successMsg],
  );

  return { run, busy };
}

// ---- Auth gate ---------------------------------------------------------------

/**
 * Operator console gate. The verdict comes from `useOperatorStatus`, which
 * mirrors the API's DISCREETLY_OPERATOR_SUBS env allowlist and NEVER retries
 * or busy-loops on failure: every non-operator outcome renders a terminal
 * state with an explicit manual action (sign in / copy sub), not a spinner.
 */
function AdminGate({ children }: { children: React.ReactNode }) {
  const operator = useOperatorStatus();

  if (operator.state === 'operator') return <>{children}</>;

  if (operator.state === 'loading') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <span className="text-sm text-muted-foreground">Checking operator access...</span>
      </div>
    );
  }

  const panel = (body: React.ReactNode) => (
    <div className="flex min-h-[40vh] items-center justify-center px-4">
      <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6">{body}</div>
    </div>
  );

  if (operator.state === 'signed-out') {
    return panel(
      <>
        <h2 className="text-base font-semibold">Operator console</h2>
        <p className="text-sm text-muted-foreground">
          Sign in with Minister to access the operator console.
        </p>
        <Button onClick={() => void signIn('minister')}>Sign in with Minister</Button>
      </>,
    );
  }

  if (operator.state === 'expired') {
    return panel(
      <>
        <h2 className="text-base font-semibold">Admin session expired</h2>
        <p className="text-sm text-muted-foreground">
          Your Minister id_token has expired (it is much shorter-lived than the login session).
          Sign in again to continue - nothing else is wrong.
        </p>
        <Button onClick={() => void signIn('minister')}>Sign in again</Button>
      </>,
    );
  }

  if (operator.state === 'not-operator') {
    return panel(
      <>
        <h2 className="text-base font-semibold">Not authorized</h2>
        <p className="text-sm text-muted-foreground">
          This account is not an operator. To grant it access, add its Ministry ID to the
          API&apos;s <code className="font-mono text-xs">DISCREETLY_OPERATOR_SUBS</code>{' '}
          (comma-separated) and restart the API.
        </p>
        <MinisterSub />
      </>,
    );
  }

  // state === 'error': a transport/server failure, NOT an auth verdict. Render
  // terminally with the message; the user can retry by reloading.
  return panel(
    <>
      <h2 className="text-base font-semibold">Operator check failed</h2>
      <p className="text-sm text-destructive">{operator.errorMessage ?? 'Unknown error.'}</p>
      <p className="text-sm text-muted-foreground">Reload the page to try again.</p>
    </>,
  );
}

/** One-line plain-language help shown under a form field. No jargon. */
function FieldHelp({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-[11px] text-muted-foreground">{children}</p>;
}

// ---- Room form state ---------------------------------------------------------

interface RoomFormState {
  name: string;
  slug: string;
  description: string;
  rateLimit: string;
  userMessageLimit: string;
  maxDevices: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  persistence: 'PERSISTENT' | 'EPHEMERAL';
  encryption: 'PLAINTEXT' | 'AES';
  password: string;
  policyRoot: PolicyBuilderNode;
  openPolicy: boolean;
}

function makeDefaultRoomForm(): RoomFormState {
  return {
    name: '',
    slug: '',
    description: '',
    rateLimit: '20',
    userMessageLimit: '100',
    maxDevices: '5',
    visibility: 'PUBLIC',
    persistence: 'PERSISTENT',
    encryption: 'PLAINTEXT',
    password: '',
    policyRoot: makeOpenPolicy(),
    openPolicy: true,
  };
}

function roomToFormState(room: AdminRoom): { form: RoomFormState; policyParseError: boolean } {
  let policyRoot: PolicyBuilderNode = makeOpenPolicy();
  let openPolicy = true;
  let policyParseError = false;
  try {
    policyRoot = deserializeNode(room.accessPolicy as unknown as never);
    openPolicy =
      policyRoot.kind === 'allOf' && (policyRoot as { children: unknown[] }).children.length === 0;
  } catch {
    // The stored policy could not be parsed into the builder tree. Do NOT silently
    // present it as "open" - that would loosen the room to admit-all on save.
    policyParseError = true;
  }

  return {
    form: {
      name: room.name,
      slug: room.slug,
      description: room.description ?? '',
      rateLimit: String(room.rateLimit),
      userMessageLimit: String(room.userMessageLimit),
      maxDevices: String(room.maxDevices),
      visibility: room.visibility,
      persistence: room.persistence,
      encryption: room.encryption,
      password: '',
      policyRoot,
      openPolicy,
    },
    policyParseError,
  };
}

// ---- Room Dialog (create / edit) --------------------------------------------

interface RoomDialogProps {
  open: boolean;
  onClose: () => void;
  editRoom?: AdminRoom | null;
}

function RoomDialog({ open, onClose, editRoom }: RoomDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [form, setForm] = React.useState<RoomFormState>(makeDefaultRoomForm);
  const [policyError, setPolicyError] = React.useState<string | null>(null);
  const [policyParseError, setPolicyParseError] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      if (editRoom) {
        const { form: nextForm, policyParseError: parseError } = roomToFormState(editRoom);
        setForm(nextForm);
        setPolicyParseError(parseError);
        if (parseError) {
          toast.error(
            'This room has a stored access policy that could not be parsed. Edit it in the builder before saving, or the room will not be loosened automatically.',
          );
        }
      } else {
        setForm(makeDefaultRoomForm());
        setPolicyParseError(false);
      }
      setPolicyError(null);
    }
  }, [open, editRoom]);

  // Use raw tRPC client for mutations to avoid TS2589 on deeply-nested router types.
  const createMut = useMutation(trpc.admin.room.create.mutationOptions());
  const updateMut = useMutation(trpc.admin.room.update.mutationOptions());

  function field<K extends keyof RoomFormState>(key: K, value: RoomFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPolicyError(null);

    let accessPolicy: unknown;
    if (form.openPolicy) {
      // Guard against silently loosening a room whose stored policy failed to
      // parse: refuse to write an open policy unless the admin opted in.
      if (policyParseError) {
        setPolicyError(
          'The existing policy could not be parsed. Switch to "Build custom policy" and define one explicitly, or confirm you intend to open this room.',
        );
        return;
      }
      accessPolicy = { allOf: [] };
    } else {
      const result = buildAndValidate(form.policyRoot);
      if (!result.ok) {
        setPolicyError(result.error);
        return;
      }
      accessPolicy = result.policy;
    }

    const shared = {
      name: form.name.trim(),
      slug: form.slug.trim(),
      description: form.description.trim() || undefined,
      rateLimit: Number(form.rateLimit),
      userMessageLimit: Number(form.userMessageLimit),
      maxDevices: Number(form.maxDevices),
      visibility: form.visibility,
      persistence: form.persistence,
      encryption: form.encryption,
      password: form.password || undefined,
      accessPolicy,
    };

    setSaving(true);
    try {
      if (editRoom) {
        await updateMut.mutateAsync({ id: editRoom.id, ...shared });
        toast.success('Room updated');
      } else {
        await createMut.mutateAsync(shared);
        toast.success('Room created');
      }
      void queryClient.invalidateQueries({ queryKey: [['admin', 'room', 'list']] });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const policyJson = React.useMemo(() => {
    if (form.openPolicy) return JSON.stringify({ allOf: [] }, null, 2);
    const result = buildAndValidate(form.policyRoot);
    if (!result.ok) return null;
    return JSON.stringify(result.policy, null, 2);
  }, [form.openPolicy, form.policyRoot]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editRoom ? 'Edit room' : 'Create room'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1 block text-xs">Name</Label>
              <Input
                required
                value={form.name}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    ...nameChangeUpdate(prev.slug, e.target.value, !!editRoom),
                  }))
                }
              />
              <FieldHelp>A friendly title shown in the room list.</FieldHelp>
            </div>
            <div>
              <Label className="mb-1 block text-xs">Slug</Label>
              <Input
                required
                readOnly
                value={form.slug}
                placeholder={editRoom ? undefined : 'fills in from the name'}
                className="bg-muted/50"
              />
              <FieldHelp>
                {editRoom
                  ? "The room's fixed web address. Renaming the room does not change it."
                  : "The room's web address. Filled in from the name for you."}
              </FieldHelp>
            </div>
          </div>

          <div>
            <Label className="mb-1 block text-xs">Description (optional)</Label>
            <Input
              value={form.description}
              onChange={(e) => field('description', e.target.value)}
            />
            <FieldHelp>One line telling people what the room is for.</FieldHelp>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="mb-1 block text-xs">Rate limit</Label>
              <Input
                type="number"
                min={1}
                required
                value={form.rateLimit}
                onChange={(e) => field('rateLimit', e.target.value)}
              />
              <FieldHelp>
                Length of each sending window, in milliseconds (60000 = 60 seconds). With the
                message limit, this is how fast a member may post - e.g. {form.userMessageLimit}{' '}
                messages per {Math.max(1, Math.round(Number(form.rateLimit) / 1000) || 0)}s.
              </FieldHelp>
            </div>
            <div>
              <Label className="mb-1 block text-xs">User message limit</Label>
              <Input
                type="number"
                min={1}
                required
                value={form.userMessageLimit}
                onChange={(e) => field('userMessageLimit', e.target.value)}
              />
              <FieldHelp>
                How many messages one member may send within each window. Going over it is treated
                as spam and removes them from the room.
              </FieldHelp>
            </div>
            <div>
              <Label className="mb-1 block text-xs">Max devices</Label>
              <Input
                type="number"
                min={1}
                required
                value={form.maxDevices}
                onChange={(e) => field('maxDevices', e.target.value)}
              />
              <FieldHelp>How many devices one person may use to join this room at once.</FieldHelp>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="mb-1 block text-xs">Visibility</Label>
              <Select
                value={form.visibility}
                onValueChange={(v) => field('visibility', v as 'PUBLIC' | 'PRIVATE')}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PUBLIC">Public</SelectItem>
                  <SelectItem value="PRIVATE">Private</SelectItem>
                </SelectContent>
              </Select>
              <FieldHelp>
                Public rooms show up in the room list. Private rooms are only reachable with a
                direct link.
              </FieldHelp>
            </div>
            <div>
              <Label className="mb-1 block text-xs">Persistence</Label>
              <Select
                value={form.persistence}
                onValueChange={(v) => field('persistence', v as 'PERSISTENT' | 'EPHEMERAL')}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PERSISTENT">Persistent</SelectItem>
                  <SelectItem value="EPHEMERAL">Ephemeral</SelectItem>
                </SelectContent>
              </Select>
              <FieldHelp>
                Persistent rooms keep their message history. Ephemeral rooms forget messages as
                soon as they are delivered.
              </FieldHelp>
            </div>
            <div>
              <Label className="mb-1 block text-xs">Encryption</Label>
              <Select
                value={form.encryption}
                onValueChange={(v) => field('encryption', v as 'PLAINTEXT' | 'AES')}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PLAINTEXT">Plaintext</SelectItem>
                  <SelectItem value="AES">AES</SelectItem>
                </SelectContent>
              </Select>
              <FieldHelp>
                Plaintext rooms are readable by the server. AES rooms are locked with a shared
                password that only members know.
              </FieldHelp>
            </div>
          </div>

          {form.encryption === 'AES' && (
            <div>
              <Label className="mb-1 block text-xs">
                Password{editRoom ? ' (leave blank to keep existing)' : ' (required)'}
              </Label>
              <Input
                type="password"
                value={form.password}
                required={!editRoom}
                onChange={(e) => field('password', e.target.value)}
              />
              <FieldHelp>
                The password used to encrypt this room&apos;s messages. Share it only with
                members you want to admit.
              </FieldHelp>
            </div>
          )}

          <div className="rounded border border-border p-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold">Access policy</span>
              <button
                type="button"
                className="text-xs text-primary underline"
                onClick={() => {
                  // Building a custom policy clears the unparsed-policy guard.
                  if (form.openPolicy) setPolicyParseError(false);
                  field('openPolicy', !form.openPolicy);
                }}
              >
                {form.openPolicy ? 'Build custom policy' : 'Use open policy (admit all)'}
              </button>
            </div>

            <FieldHelp>
              Who is allowed to join. Leave it open for anyone signed in, or require one or more
              Ministry ID badges (for example an invite code or a verified account).
            </FieldHelp>

            {policyParseError && (
              <p className="mb-2 rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-700">
                The stored access policy for this room could not be parsed into the
                builder. Saving with the open policy would loosen the room. Build a
                policy explicitly to continue.
              </p>
            )}

            {form.openPolicy ? (
              <p className="text-xs text-muted-foreground">
                Open - any visitor may join (no badge required).
              </p>
            ) : (
              <PolicyBuilder root={form.policyRoot} onChange={(r) => field('policyRoot', r)} />
            )}

            {policyError && <p className="mt-2 text-xs text-destructive">{policyError}</p>}

            {policyJson && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Policy JSON preview
                </summary>
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                  {policyJson}
                </pre>
              </details>
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : editRoom ? 'Save changes' : 'Create room'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Rooms tab ---------------------------------------------------------------

function RoomsTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const roomsQ = useQuery(trpc.admin.room.list.queryOptions());
  const rooms = asAdminRooms(roomsQ.data ?? []);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editRoom, setEditRoom] = React.useState<AdminRoom | null>(null);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [seeding, setSeeding] = React.useState(false);
  // Room id with a pin/unpin call in flight (per-row disable).
  const [pinning, setPinning] = React.useState<string | null>(null);

  const deleteMut = useMutation(trpc.admin.room.delete.mutationOptions());
  const seedMut = useMutation(trpc.admin.room.seedDefaults.mutationOptions());
  const updateMut = useMutation(trpc.admin.room.update.mutationOptions());

  const invalidateRooms = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: [['admin', 'room', 'list']] }),
    [queryClient],
  );

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await deleteMut.mutateAsync({ id: deleteId });
      void invalidateRooms();
      toast.success('Room deleted');
      setDeleteId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  async function handleSeed() {
    setSeeding(true);
    try {
      const res = (await seedMut.mutateAsync()) as { created: string[]; skipped: string[] };
      void invalidateRooms();
      if (res.created.length > 0) {
        toast.success(`Seeded: ${res.created.join(', ')}`);
      } else {
        toast.info('Starter rooms already exist - nothing seeded.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Seeding failed');
    } finally {
      setSeeding(false);
    }
  }

  async function handleTogglePin(room: AdminRoom) {
    setPinning(room.id);
    try {
      await updateMut.mutateAsync({ id: room.id, pinned: !room.pinned });
      void invalidateRooms();
      toast.success(room.pinned ? 'Room unpinned' : 'Room pinned');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Pin toggle failed');
    } finally {
      setPinning(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Rooms</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={seeding} onClick={() => void handleSeed()}>
            {seeding ? 'Seeding...' : 'Seed starter rooms'}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditRoom(null);
              setDialogOpen(true);
            }}
          >
            + Create room
          </Button>
        </div>
      </div>

      {roomsQ.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {roomsQ.isError && <p className="text-sm text-destructive">{roomsQ.error.message}</p>}

      {!roomsQ.isLoading && rooms.length === 0 && (
        <p className="text-sm text-muted-foreground">No rooms yet.</p>
      )}

      {rooms.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Visibility</TableHead>
              <TableHead>Encryption</TableHead>
              <TableHead>Members</TableHead>
              <TableHead>Messages</TableHead>
              <TableHead>Pinned</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rooms.map((room) => (
              <TableRow key={room.id}>
                <TableCell className="font-medium">{room.name}</TableCell>
                <TableCell className="font-mono text-xs">{room.slug}</TableCell>
                <TableCell className="text-xs">{room.visibility}</TableCell>
                <TableCell className="text-xs">{room.encryption}</TableCell>
                <TableCell className="text-xs">{room._count.memberships}</TableCell>
                <TableCell className="text-xs">{room._count.messages}</TableCell>
                <TableCell className="text-xs">
                  {room.pinned ? <Badge variant="secondary">pinned</Badge> : '-'}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={pinning === room.id}
                      onClick={() => void handleTogglePin(room)}
                    >
                      {pinning === room.id ? '...' : room.pinned ? 'Unpin' : 'Pin'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setEditRoom(room);
                        setDialogOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-destructive"
                      onClick={() => setDeleteId(room.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <RoomDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditRoom(null);
        }}
        editRoom={editRoom}
      />

      <Dialog open={deleteId !== null} onOpenChange={(v) => !v && setDeleteId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete room?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This is permanent. All memberships and messages will be deleted.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" disabled={deleting} onClick={() => void handleDelete()}>
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- Bans tab ----------------------------------------------------------------

function BansTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const roomsQ = useQuery(trpc.admin.room.list.queryOptions());
  const rooms = asAdminRooms(roomsQ.data ?? []);

  const [selectedRoom, setSelectedRoom] = React.useState('');
  const [icValue, setIcValue] = React.useState('');
  const [jnValue, setJnValue] = React.useState('');
  const [unbanJn, setUnbanJn] = React.useState('');

  const bansQ = useQuery({
    ...trpc.admin.bans.queryOptions({ roomId: selectedRoom }),
    enabled: !!selectedRoom,
  });
  const bans = asBanRows(bansQ.data ?? []);
  const invalidateBans = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: [['admin', 'bans']] }),
    [queryClient],
  );

  const banIc = useAdminMutation(
    trpc.admin.banByIdentityCommitment.mutationOptions(),
    'Banned by identity commitment',
  );
  const banJn = useAdminMutation(
    trpc.admin.banByJoinNullifier.mutationOptions(),
    'Banned by join nullifier',
  );
  const unban = useAdminMutation(trpc.admin.unban.mutationOptions(), 'Unbanned');
  const busyIc = banIc.busy;
  const busyJn = banJn.busy;
  const busyUnban = unban.busy;

  async function handleBanIc() {
    if (!selectedRoom || !icValue.trim()) return;
    if (await banIc.run({ roomId: selectedRoom, identityCommitment: icValue.trim() })) {
      setIcValue('');
      void invalidateBans();
    }
  }

  async function handleBanJn() {
    if (!selectedRoom || !jnValue.trim()) return;
    if (await banJn.run({ roomId: selectedRoom, joinNullifier: jnValue.trim() })) {
      setJnValue('');
      void invalidateBans();
    }
  }

  async function handleUnban(joinNullifier?: string) {
    const jn = (joinNullifier ?? unbanJn).trim();
    if (!selectedRoom || !jn) return;
    if (await unban.run({ roomId: selectedRoom, joinNullifier: jn })) {
      if (!joinNullifier) setUnbanJn('');
      void invalidateBans();
    }
  }

  return (
    <div className="space-y-8">
      <h2 className="text-base font-semibold">Ban management</h2>

      <div>
        <Label className="mb-1 block text-xs">Room</Label>
        <Select value={selectedRoom} onValueChange={setSelectedRoom}>
          <SelectTrigger className="max-w-xs">
            <SelectValue placeholder="Select a room" />
          </SelectTrigger>
          <SelectContent>
            {rooms.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedRoom ? (
        <section className="space-y-2 rounded border border-border p-4">
          <h3 className="text-sm font-semibold">Active bans</h3>
          {bansQ.isError && <p className="text-xs text-destructive">{bansQ.error.message}</p>}
          {!bansQ.isError && bans.length === 0 && !bansQ.isLoading && (
            <p className="text-xs text-muted-foreground">No bans in this room.</p>
          )}
          {bans.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Join nullifier</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bans.map((ban) => (
                  <TableRow key={ban.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(ban.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge
                        variant={ban.reason === 'RATE_LIMIT_COLLISION' ? 'destructive' : 'secondary'}
                      >
                        {ban.reason === 'RATE_LIMIT_COLLISION' ? 'rate-limit' : 'operator'}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-xs text-muted-foreground">
                      {ban.joinNullifier ?? '-'}
                    </TableCell>
                    <TableCell>
                      {ban.joinNullifier ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={busyUnban}
                          onClick={() => void handleUnban(ban.joinNullifier ?? undefined)}
                        >
                          Unban
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      ) : null}

      <section className="space-y-2 rounded border border-border p-4">
        <h3 className="text-sm font-semibold">Ban by identity commitment</h3>
        <p className="text-xs text-muted-foreground">
          Bans every device (leaf) that belongs to the identity commitment.
        </p>
        <div className="flex gap-2">
          <Input
            placeholder="Identity commitment (bigint string)"
            value={icValue}
            onChange={(e) => setIcValue(e.target.value)}
            className="flex-1 font-mono text-xs"
          />
          <Button
            variant="destructive"
            size="sm"
            disabled={!selectedRoom || !icValue.trim() || busyIc}
            onClick={() => void handleBanIc()}
          >
            Ban
          </Button>
        </div>
      </section>

      <section className="space-y-2 rounded border border-border p-4">
        <h3 className="text-sm font-semibold">Ban by join nullifier</h3>
        <p className="text-xs text-muted-foreground">
          Bans a specific membership by its join nullifier.
        </p>
        <div className="flex gap-2">
          <Input
            placeholder="Join nullifier (bigint string)"
            value={jnValue}
            onChange={(e) => setJnValue(e.target.value)}
            className="flex-1 font-mono text-xs"
          />
          <Button
            variant="destructive"
            size="sm"
            disabled={!selectedRoom || !jnValue.trim() || busyJn}
            onClick={() => void handleBanJn()}
          >
            Ban
          </Button>
        </div>
      </section>

      <section className="space-y-2 rounded border border-border p-4">
        <h3 className="text-sm font-semibold">Unban by join nullifier</h3>
        <div className="flex gap-2">
          <Input
            placeholder="Join nullifier (bigint string)"
            value={unbanJn}
            onChange={(e) => setUnbanJn(e.target.value)}
            className="flex-1 font-mono text-xs"
          />
          <Button
            size="sm"
            disabled={!selectedRoom || !unbanJn.trim() || busyUnban}
            onClick={() => void handleUnban()}
          >
            Unban
          </Button>
        </div>
      </section>
    </div>
  );
}

// ---- Members tab -------------------------------------------------------------

function MembersTab() {
  const trpc = useTRPC();
  const roomsQ = useQuery(trpc.admin.room.list.queryOptions());
  const rooms = asAdminRooms(roomsQ.data ?? []);

  const [selectedRoom, setSelectedRoom] = React.useState('');
  // The join nullifier of the row whose action is in flight, for per-row spinners.
  const [pending, setPending] = React.useState<string | null>(null);

  const membershipsQ = useQuery({
    ...trpc.admin.room.memberships.queryOptions({ roomId: selectedRoom }),
    enabled: !!selectedRoom,
  });
  const memberships = asAdminMemberships(membershipsQ.data ?? []);

  const banJn = useAdminMutation(
    trpc.admin.banByJoinNullifier.mutationOptions(),
    'Member banned',
  );
  const unbanJn = useAdminMutation(trpc.admin.unban.mutationOptions(), 'Member unbanned');

  async function handleBan(joinNullifier: string) {
    setPending(joinNullifier);
    try {
      await banJn.run({ roomId: selectedRoom, joinNullifier });
    } finally {
      setPending(null);
    }
  }

  async function handleUnban(joinNullifier: string) {
    setPending(joinNullifier);
    try {
      await unbanJn.run({ roomId: selectedRoom, joinNullifier });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">Members</h2>

      <div>
        <Label className="mb-1 block text-xs">Room</Label>
        <Select value={selectedRoom} onValueChange={setSelectedRoom}>
          <SelectTrigger className="max-w-xs">
            <SelectValue placeholder="Select a room" />
          </SelectTrigger>
          <SelectContent>
            {rooms.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {membershipsQ.isLoading && selectedRoom && (
        <p className="text-sm text-muted-foreground">Loading members...</p>
      )}
      {membershipsQ.isError && (
        <p className="text-sm text-destructive">{membershipsQ.error.message}</p>
      )}
      {memberships.length === 0 && selectedRoom && !membershipsQ.isLoading && (
        <p className="text-sm text-muted-foreground">No members in this room.</p>
      )}

      {memberships.length > 0 && (
        <div className="space-y-4">
          {memberships.map((m: AdminMembership) => (
            <div key={m.joinNullifier} className="rounded border border-border p-4">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div>
                  <Badge variant={m.status === 'BANNED' ? 'destructive' : 'success'}>
                    {m.status}
                  </Badge>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    jn: {m.joinNullifier}
                  </p>
                </div>
                {m.status === 'BANNED' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2 text-xs"
                    disabled={pending === m.joinNullifier}
                    onClick={() => void handleUnban(m.joinNullifier)}
                  >
                    {pending === m.joinNullifier ? 'Unbanning...' : 'Unban'}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2 text-xs text-destructive"
                    disabled={pending === m.joinNullifier}
                    onClick={() => void handleBan(m.joinNullifier)}
                  >
                    {pending === m.joinNullifier ? 'Banning...' : 'Ban'}
                  </Button>
                )}
              </div>

              {m.leaves.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Leaves (devices)</p>
                  {m.leaves.map((leaf) => (
                    <div key={leaf.identityCommitment} className="rounded bg-muted/40 p-2 text-xs">
                      <p className="break-all font-mono">IC: {leaf.identityCommitment}</p>
                      {leaf.deviceLabel && (
                        <p className="text-muted-foreground">Label: {leaf.deviceLabel}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Audit tab ---------------------------------------------------------------

function AuditTab() {
  const trpc = useTRPC();
  const roomsQ = useQuery(trpc.admin.room.list.queryOptions());
  const rooms = asAdminRooms(roomsQ.data ?? []);

  // Radix Select forbids an empty-string item value, so "all rooms" uses a
  // sentinel that maps back to no room filter.
  const ALL_ROOMS = '__all__';
  const [filterRoom, setFilterRoom] = React.useState(ALL_ROOMS);
  const [filterActor, setFilterActor] = React.useState('');
  const [filterAction, setFilterAction] = React.useState('');
  const [limit, setLimit] = React.useState('100');

  const auditInput = {
    roomId: filterRoom === ALL_ROOMS ? undefined : filterRoom || undefined,
    actor: filterActor.trim() || undefined,
    action: filterAction.trim() || undefined,
    limit: Math.min(500, Math.max(1, Number(limit) || 100)),
  };

  const auditQ = useQuery(trpc.admin.auditLog.queryOptions(auditInput));
  const rows = asAuditLogRows(auditQ.data ?? []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Audit log</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void auditQ.refetch()}
          disabled={auditQ.isFetching}
        >
          {auditQ.isFetching ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <Label className="mb-1 block text-xs">Room</Label>
          <Select value={filterRoom} onValueChange={setFilterRoom}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue placeholder="All rooms" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ROOMS}>All rooms</SelectItem>
              {rooms.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1 block text-xs">Actor (sub)</Label>
          <Input
            className="h-9 text-xs"
            placeholder="any"
            value={filterActor}
            onChange={(e) => setFilterActor(e.target.value)}
          />
        </div>
        <div>
          <Label className="mb-1 block text-xs">Action</Label>
          <Input
            className="h-9 text-xs"
            placeholder="e.g. ROOM_CREATE"
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
          />
        </div>
        <div>
          <Label className="mb-1 block text-xs">Limit</Label>
          <Input
            className="h-9 text-xs"
            type="number"
            min={1}
            max={500}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </div>
      </div>

      {auditQ.isError && <p className="text-sm text-destructive">{auditQ.error.message}</p>}
      {rows.length === 0 && !auditQ.isLoading && (
        <p className="text-sm text-muted-foreground">No audit entries match the filters.</p>
      )}

      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Metadata</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row: AuditLogRow) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap text-xs">
                  {new Date(row.createdAt).toLocaleString()}
                </TableCell>
                <TableCell className="text-xs font-medium">{row.action}</TableCell>
                <TableCell className="max-w-[120px] truncate font-mono text-xs text-muted-foreground">
                  {row.actor}
                </TableCell>
                <TableCell className="max-w-[120px] truncate font-mono text-xs text-muted-foreground">
                  {row.target ?? '-'}
                </TableCell>
                <TableCell className="max-w-[180px] text-xs text-muted-foreground">
                  {row.metadata ? (
                    <span
                      className="block cursor-help truncate"
                      title={JSON.stringify(row.metadata, null, 2)}
                    >
                      {JSON.stringify(row.metadata)}
                    </span>
                  ) : (
                    '-'
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ---- Broadcast tab -----------------------------------------------------------

function BroadcastTab() {
  const trpc = useTRPC();
  const roomsQ = useQuery(trpc.admin.room.list.queryOptions());
  const rooms = asAdminRooms(roomsQ.data ?? []);

  const [selectedRoom, setSelectedRoom] = React.useState('');
  const [text, setText] = React.useState('');
  const [sending, setSending] = React.useState(false);

  const broadcastMut = useMutation(trpc.admin.broadcast.mutationOptions());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedRoom || !text.trim()) return;
    setSending(true);
    try {
      await broadcastMut.mutateAsync({ roomId: selectedRoom, text: text.trim() });
      toast.success('Broadcast sent');
      setText('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Broadcast failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">System broadcast</h2>
      <p className="text-sm text-muted-foreground">
        Send a system message to all subscribers of a room.
      </p>

      <form onSubmit={(e) => void handleSubmit(e)} className="max-w-lg space-y-4">
        <div>
          <Label className="mb-1 block text-xs">Room</Label>
          <Select value={selectedRoom} onValueChange={setSelectedRoom}>
            <SelectTrigger>
              <SelectValue placeholder="Select a room" />
            </SelectTrigger>
            <SelectContent>
              {rooms.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="mb-1 block text-xs">Message</Label>
          <Textarea
            required
            placeholder="Enter broadcast message..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
          />
        </div>

        <Button type="submit" disabled={!selectedRoom || !text.trim() || sending}>
          {sending ? 'Sending...' : 'Send broadcast'}
        </Button>
      </form>
    </div>
  );
}

// ---- Admin dashboard ---------------------------------------------------------

function AdminDashboard() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:py-10">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Admin dashboard</h1>
        {/* The operator's own sub: the value DISCREETLY_OPERATOR_SUBS holds. */}
        <MinisterSub className="max-w-sm" />
      </header>

      <Tabs defaultValue="rooms">
        <TabsList className="mb-6">
          <TabsTrigger value="rooms">Rooms</TabsTrigger>
          <TabsTrigger value="bans">Bans</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="broadcast">Broadcast</TabsTrigger>
        </TabsList>

        <TabsContent value="rooms">
          <RoomsTab />
        </TabsContent>
        <TabsContent value="bans">
          <BansTab />
        </TabsContent>
        <TabsContent value="members">
          <MembersTab />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab />
        </TabsContent>
        <TabsContent value="broadcast">
          <BroadcastTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function AdminPage() {
  return (
    <AdminGate>
      <AdminDashboard />
    </AdminGate>
  );
}
