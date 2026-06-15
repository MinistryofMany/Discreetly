'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc';
import {
  type AdminRoom,
  type AdminMembership,
  type AuditLogRow,
  asAdminRooms,
  asAdminMemberships,
  asAuditLogRows,
} from '@/lib/admin-types';
import {
  type PolicyBuilderNode,
  buildAndValidate,
  makeOpenPolicy,
  deserializeNode,
} from '@/lib/policy-builder';
import { PolicyBuilder } from '@/components/admin/policy-builder';
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

// ---- Auth gate ---------------------------------------------------------------

function AdminGate({ children }: { children: React.ReactNode }) {
  const trpc = useTRPC();
  // whoami forwards the session id_token as a Bearer header. Wait until the
  // session has loaded so the very first request carries the token (otherwise
  // an unauthenticated request 401s and, with retry disabled, never recovers).
  const { status } = useSession();
  const authenticated = status === 'authenticated';
  const whoami = useQuery({
    ...trpc.admin.whoami.queryOptions(),
    retry: false,
    enabled: authenticated,
  });

  if (status === 'loading' || (authenticated && (whoami.isLoading || whoami.isPending))) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <span className="text-sm text-muted-foreground">Checking admin access...</span>
      </div>
    );
  }

  if (!authenticated || whoami.isError || !whoami.data) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-destructive">Not authorized.</p>
      </div>
    );
  }

  return <>{children}</>;
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
    maxDevices: '3',
    visibility: 'PUBLIC',
    persistence: 'PERSISTENT',
    encryption: 'PLAINTEXT',
    password: '',
    policyRoot: makeOpenPolicy(),
    openPolicy: true,
  };
}

function roomToFormState(room: AdminRoom): RoomFormState {
  let policyRoot: PolicyBuilderNode = makeOpenPolicy();
  let openPolicy = true;
  try {
    policyRoot = deserializeNode(room.accessPolicy as Record<string, unknown> as never);
    openPolicy =
      policyRoot.kind === 'allOf' &&
      (policyRoot as { children: unknown[] }).children.length === 0;
  } catch {
    // fallback to open
  }

  return {
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
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setForm(editRoom ? roomToFormState(editRoom) : makeDefaultRoomForm());
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
                onChange={(e) => field('name', e.target.value)}
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs">Slug</Label>
              <Input
                required
                value={form.slug}
                onChange={(e) => field('slug', e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label className="mb-1 block text-xs">Description (optional)</Label>
            <Input
              value={form.description}
              onChange={(e) => field('description', e.target.value)}
            />
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
            </div>
          )}

          <div className="rounded border border-border p-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold">Access policy</span>
              <button
                type="button"
                className="text-xs text-primary underline"
                onClick={() => field('openPolicy', !form.openPolicy)}
              >
                {form.openPolicy ? 'Build custom policy' : 'Use open policy (admit all)'}
              </button>
            </div>

            {form.openPolicy ? (
              <p className="text-xs text-muted-foreground">
                Open - any visitor may join (no badge required).
              </p>
            ) : (
              <PolicyBuilder
                root={form.policyRoot}
                onChange={(r) => field('policyRoot', r)}
              />
            )}

            {policyError && (
              <p className="mt-2 text-xs text-destructive">{policyError}</p>
            )}

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

  const deleteMut = useMutation(trpc.admin.room.delete.mutationOptions());

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await deleteMut.mutateAsync({ id: deleteId });
      void queryClient.invalidateQueries({ queryKey: [['admin', 'room', 'list']] });
      toast.success('Room deleted');
      setDeleteId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Rooms</h2>
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

      {roomsQ.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {roomsQ.isError && (
        <p className="text-sm text-destructive">{roomsQ.error.message}</p>
      )}

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
                <TableCell>
                  <div className="flex gap-1">
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
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleDelete()}
            >
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
  const [busyIc, setBusyIc] = React.useState(false);
  const [busyJn, setBusyJn] = React.useState(false);
  const [busyUnban, setBusyUnban] = React.useState(false);

  const banByIcMut = useMutation(trpc.admin.banByIdentityCommitment.mutationOptions());
  const banByJnMut = useMutation(trpc.admin.banByJoinNullifier.mutationOptions());
  const unbanMut = useMutation(trpc.admin.unban.mutationOptions());

  async function handleBanIc() {
    if (!selectedRoom || !icValue.trim()) return;
    setBusyIc(true);
    try {
      await banByIcMut.mutateAsync({ roomId: selectedRoom, identityCommitment: icValue.trim() });
      void queryClient.invalidateQueries({ queryKey: [['admin', 'room', 'memberships']] });
      toast.success('Banned by identity commitment');
      setIcValue('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ban failed');
    } finally {
      setBusyIc(false);
    }
  }

  async function handleBanJn() {
    if (!selectedRoom || !jnValue.trim()) return;
    setBusyJn(true);
    try {
      await banByJnMut.mutateAsync({ roomId: selectedRoom, joinNullifier: jnValue.trim() });
      void queryClient.invalidateQueries({ queryKey: [['admin', 'room', 'memberships']] });
      toast.success('Banned by join nullifier');
      setJnValue('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ban failed');
    } finally {
      setBusyJn(false);
    }
  }

  async function handleUnban() {
    if (!selectedRoom || !unbanJn.trim()) return;
    setBusyUnban(true);
    try {
      await unbanMut.mutateAsync({ roomId: selectedRoom, joinNullifier: unbanJn.trim() });
      void queryClient.invalidateQueries({ queryKey: [['admin', 'room', 'memberships']] });
      toast.success('Unbanned');
      setUnbanJn('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unban failed');
    } finally {
      setBusyUnban(false);
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
  const queryClient = useQueryClient();
  const roomsQ = useQuery(trpc.admin.room.list.queryOptions());
  const rooms = asAdminRooms(roomsQ.data ?? []);

  const [selectedRoom, setSelectedRoom] = React.useState('');
  const [banning, setBanning] = React.useState<string | null>(null);

  const membershipsQ = useQuery({
    ...trpc.admin.room.memberships.queryOptions({ roomId: selectedRoom }),
    enabled: !!selectedRoom,
  });
  const memberships = asAdminMemberships(membershipsQ.data ?? []);

  const banMut = useMutation(trpc.admin.banByJoinNullifier.mutationOptions());

  async function handleBan(joinNullifier: string) {
    setBanning(joinNullifier);
    try {
      await banMut.mutateAsync({ roomId: selectedRoom, joinNullifier });
      void queryClient.invalidateQueries({
        queryKey: [['admin', 'room', 'memberships']],
      });
      toast.success('Member banned');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ban failed');
    } finally {
      setBanning(null);
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
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${
                      m.status === 'BANNED'
                        ? 'bg-destructive/20 text-destructive'
                        : 'bg-green-100 text-green-700'
                    }`}
                  >
                    {m.status}
                  </span>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    jn: {m.joinNullifier}
                  </p>
                </div>
                {m.status !== 'BANNED' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2 text-xs text-destructive"
                    disabled={banning === m.joinNullifier}
                    onClick={() => void handleBan(m.joinNullifier)}
                  >
                    {banning === m.joinNullifier ? 'Banning...' : 'Ban'}
                  </Button>
                )}
              </div>

              {m.leaves.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Leaves (devices)</p>
                  {m.leaves.map((leaf) => (
                    <div
                      key={leaf.identityCommitment}
                      className="rounded bg-muted/40 p-2 text-xs"
                    >
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

      {auditQ.isError && (
        <p className="text-sm text-destructive">{auditQ.error.message}</p>
      )}
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
                <TableCell className="max-w-[180px] truncate text-xs text-muted-foreground">
                  {row.metadata ? JSON.stringify(row.metadata) : '-'}
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

        <Button
          type="submit"
          disabled={!selectedRoom || !text.trim() || sending}
        >
          {sending ? 'Sending...' : 'Send broadcast'}
        </Button>
      </form>
    </div>
  );
}

// ---- Admin dashboard ---------------------------------------------------------

function AdminDashboard() {
  return (
    <main className="container mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Admin dashboard</h1>
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
    </main>
  );
}

export default function AdminPage() {
  return (
    <AdminGate>
      <AdminDashboard />
    </AdminGate>
  );
}
