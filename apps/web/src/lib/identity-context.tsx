'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import {
  type AppIdentity,
  createIdentity,
  deriveIdentityFromDeviceSeed,
  hasStoredIdentity,
  saveEncrypted,
  unlock as unlockStored,
  clear as clearStored,
} from './identity';
import { ministerAnonSettled, readMinisterDeviceSeed } from './minister-anon';

interface IdentityContextValue {
  /** The unlocked identity, or null when locked / not yet created. */
  identity: AppIdentity | null;
  /** True if an encrypted identity exists in localStorage. */
  hasStored: boolean;
  /** Generate a new identity, encrypt under `password`, persist, and unlock it. */
  create: (password: string) => Promise<AppIdentity>;
  /** Unlock the stored identity with `password`. Throws on wrong password. */
  unlock: (password: string) => Promise<AppIdentity>;
  /** Drop the in-memory unlocked identity (keeps the encrypted copy at rest). */
  lock: () => void;
  /** Adopt an externally produced identity (e.g. imported backup) into memory. */
  setUnlocked: (identity: AppIdentity) => void;
  /** Persist an in-memory identity under a (new) password. */
  persist: (identity: AppIdentity, password: string) => Promise<void>;
  /** Remove the stored identity and lock. */
  clear: () => void;
  /** Re-read whether an encrypted identity is present (after import/clear). */
  refresh: () => void;
}

const IdentityContext = React.createContext<IdentityContextValue | null>(null);

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentity] = React.useState<AppIdentity | null>(null);
  const [hasStored, setHasStored] = React.useState(false);
  const { data: session } = useSession();
  const sub = session?.sub ?? null;

  React.useEffect(() => {
    setHasStored(hasStoredIdentity());
  }, []);

  const refresh = React.useCallback(() => {
    setHasStored(hasStoredIdentity());
  }, []);

  const create = React.useCallback(
    async (password: string) => {
      // Ministry anonymous-identity handoff: when a Ministry-derived device
      // seed is cached for the signed-in sub (see minister-anon.ts), derive
      // the identity deterministically from it - same account, same identity
      // on every device. No cached seed (or signed out) -> today's random
      // generation, byte-identical. A derivation FAILURE with a seed present
      // falls back to random but is signaled - a silent fallback would let
      // the user believe the identity is Ministry-recoverable when it is not.
      let id: AppIdentity | null = null;
      if (sub !== null) {
        await ministerAnonSettled();
        const seed = readMinisterDeviceSeed(sub);
        if (seed !== null) {
          try {
            id = await deriveIdentityFromDeviceSeed(seed);
          } catch (error) {
            console.warn(
              'minister-anon: identity derivation from the cached device seed failed; ' +
                'creating a local-only identity instead (fail-closed)',
              error,
            );
            toast.warning(
              'Your Ministry-linked identity could not be derived; this identity is local-only (not recoverable via Ministry).',
            );
          } finally {
            seed.fill(0);
          }
        }
      }
      if (id === null) id = createIdentity();
      await saveEncrypted(id, password);
      setIdentity(id);
      setHasStored(true);
      return id;
    },
    [sub],
  );

  const unlock = React.useCallback(async (password: string) => {
    const id = await unlockStored(password);
    setIdentity(id);
    return id;
  }, []);

  const lock = React.useCallback(() => setIdentity(null), []);

  const setUnlocked = React.useCallback((id: AppIdentity) => setIdentity(id), []);

  const persist = React.useCallback(async (id: AppIdentity, password: string) => {
    await saveEncrypted(id, password);
    setIdentity(id);
    setHasStored(true);
  }, []);

  const clear = React.useCallback(() => {
    clearStored();
    setIdentity(null);
    setHasStored(false);
  }, []);

  const value = React.useMemo<IdentityContextValue>(
    () => ({
      identity,
      hasStored,
      create,
      unlock,
      lock,
      setUnlocked,
      persist,
      clear,
      refresh,
    }),
    [identity, hasStored, create, unlock, lock, setUnlocked, persist, clear, refresh],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityContextValue {
  const ctx = React.useContext(IdentityContext);
  if (!ctx) throw new Error('useIdentity must be used within an IdentityProvider.');
  return ctx;
}
