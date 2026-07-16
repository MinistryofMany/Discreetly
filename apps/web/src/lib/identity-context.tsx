'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { type AppIdentity, deriveRoomIdentity } from './identity';
import { adoptMinisterBranch, hasMinisterBranch, readMinisterBranch } from './minister-anon';

interface IdentityContextValue {
  /** A Ministry branch is cached for the signed-in account. */
  hasBranch: boolean;
  /** The branch-adoption effect has settled (so `hasBranch` is authoritative). */
  ready: boolean;
  /**
   * Derive this account's identity for `roomId` from the cached branch, or null
   * when no branch is cached (not signed in via Ministry, or the handoff has not
   * completed). Deterministic: same account + room -> same identity everywhere.
   */
  deriveForRoom: (roomId: string) => Promise<AppIdentity | null>;
}

const IdentityContext = React.createContext<IdentityContextValue | null>(null);

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const sub = session?.sub ?? null;
  const tokenEpoch = session?.anonEpoch ?? undefined;

  const [hasBranch, setHasBranch] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  // Adopt any freshly-captured branch once the session (sub + signed epoch) is
  // known. `adoptMinisterBranch` is epoch-gated and idempotent (it consumes the
  // captured branch), so re-runs are safe.
  React.useEffect(() => {
    if (sub === null) {
      setHasBranch(false);
      setReady(true);
      return;
    }
    adoptMinisterBranch(sub, tokenEpoch);
    setHasBranch(hasMinisterBranch(sub));
    setReady(true);
  }, [sub, tokenEpoch]);

  const deriveForRoom = React.useCallback(
    async (roomId: string): Promise<AppIdentity | null> => {
      if (sub === null) return null;
      const branch = readMinisterBranch(sub);
      if (branch === null) return null;
      try {
        return await deriveRoomIdentity(branch, roomId);
      } finally {
        branch.fill(0);
      }
    },
    [sub],
  );

  const value = React.useMemo<IdentityContextValue>(
    () => ({ hasBranch, ready, deriveForRoom }),
    [hasBranch, ready, deriveForRoom],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityContextValue {
  const ctx = React.useContext(IdentityContext);
  if (!ctx) throw new Error('useIdentity must be used within an IdentityProvider.');
  return ctx;
}

/**
 * Derive (and memoize) the current account's identity for a room. `identity` is
 * null while deriving or when no branch is cached; `loading` is true until the
 * first derivation settles. Re-derives when the account or room changes.
 */
export function useRoomIdentity(roomId: string): {
  identity: AppIdentity | null;
  loading: boolean;
} {
  const { deriveForRoom, ready } = useIdentity();
  const [identity, setIdentity] = React.useState<AppIdentity | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void deriveForRoom(roomId).then((id) => {
      if (cancelled) return;
      setIdentity(id);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // `ready` gates the first derivation until branch adoption has settled.
  }, [deriveForRoom, roomId, ready]);

  return { identity, loading };
}
