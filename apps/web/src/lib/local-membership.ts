/**
 * Local record of the rooms this browser has joined. Written on a successful
 * `membership.join`, read by:
 *
 * - the rooms home ("Joined" section),
 * - the composer, which attaches the stored join nullifier to `message.send`
 *   as the CLIENT-ASSERTED moderation link (operator ban-author path). The
 *   nullifier is the user's own room pseudonym, returned by the join; it
 *   lives only in this browser's localStorage.
 *
 * Storage failures degrade silently to "no local record" - membership truth
 * stays server-side (the leaf set).
 */

export interface LocalMembership {
  roomId: string;
  /** The caller's own join nullifier for the room (decimal bigint string). */
  joinNullifier: string;
  /** ISO timestamp of the local join, newest-first ordering for the UI. */
  joinedAt: string;
}

const KEY = 'discreetly.memberships.v1';

function readAll(): LocalMembership[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is LocalMembership =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as LocalMembership).roomId === 'string' &&
        typeof (m as LocalMembership).joinNullifier === 'string' &&
        typeof (m as LocalMembership).joinedAt === 'string',
    );
  } catch {
    // Corrupt store: treat as empty rather than breaking the rooms page.
    return [];
  }
}

/** All locally-recorded memberships, newest join first. */
export function listLocalMemberships(): LocalMembership[] {
  return readAll().sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
}

/** The local membership record for a room, or null. */
export function getLocalMembership(roomId: string): LocalMembership | null {
  return readAll().find((m) => m.roomId === roomId) ?? null;
}

/** Record (or refresh) a room membership after a successful join. */
export function recordLocalMembership(roomId: string, joinNullifier: string): void {
  if (typeof localStorage === 'undefined') return;
  const rest = readAll().filter((m) => m.roomId !== roomId);
  const next: LocalMembership[] = [
    { roomId, joinNullifier, joinedAt: new Date().toISOString() },
    ...rest,
  ];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota/permission failure: the join still succeeded server-side; the
    // only loss is the local "Joined" hint and the ban-author link.
  }
}
