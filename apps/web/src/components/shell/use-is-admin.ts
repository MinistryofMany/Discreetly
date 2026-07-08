'use client';

import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTRPC } from '@/lib/trpc';
import { idTokenExpiresAt } from '@/lib/minister-claims';

/**
 * Operator (service-runner) auth state for the current browser session. The
 * API gates admin procedures on the DISCREETLY_OPERATOR_SUBS env allowlist;
 * this hook mirrors that verdict client-side WITHOUT ever busy-looping:
 *
 * - `admin.whoami` is queried at most once per mount (retry: false), and only
 *   while a session exists AND its id_token is not already known-expired
 *   (checked locally from the decoded exp, so an expired token never even
 *   fires the request - the old behavior 401-spammed the API on every load).
 * - A 401 maps to 'expired' (the 30-day Auth.js session outlives the ~10 min
 *   Minister id_token; signing in again mints a fresh token), a 403 to
 *   'not-operator', anything else to 'error'. None of these retry.
 */
export type OperatorState =
  | 'loading'
  | 'signed-out'
  | 'expired'
  | 'not-operator'
  | 'operator'
  | 'error';

export interface OperatorStatus {
  state: OperatorState;
  /** The caller's own Minister pairwise sub (decoded, display-only). */
  sub: string | null;
  /** Transport/server error detail for state === 'error'. */
  errorMessage: string | null;
}

/** Small skew so a token a few seconds from expiry is not raced to the API. */
const EXPIRY_SKEW_MS = 10_000;

function trpcCodeOf(error: unknown): string | undefined {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  return typeof code === 'string' ? code : undefined;
}

export function useOperatorStatus(): OperatorStatus {
  const trpc = useTRPC();
  const { data: session, status } = useSession();

  const idToken = session?.idToken ?? null;
  const exp = idTokenExpiresAt(idToken);
  const tokenExpired =
    status === 'authenticated' &&
    (idToken === null || (exp !== null && exp * 1000 <= Date.now() + EXPIRY_SKEW_MS));

  const whoami = useQuery({
    ...trpc.admin.whoami.queryOptions(),
    // NEVER retry: a 401/403 is a verdict, not a transient. Retrying is what
    // produced the admin.whoami 401 storm.
    retry: false,
    staleTime: 60_000,
    enabled: status === 'authenticated' && !tokenExpired,
  });

  const sub = session?.sub ?? null;

  if (status === 'loading') return { state: 'loading', sub, errorMessage: null };
  if (status !== 'authenticated') return { state: 'signed-out', sub: null, errorMessage: null };
  if (tokenExpired) return { state: 'expired', sub, errorMessage: null };
  if (whoami.isPending) return { state: 'loading', sub, errorMessage: null };
  if (whoami.isError) {
    const code = trpcCodeOf(whoami.error);
    if (code === 'UNAUTHORIZED') return { state: 'expired', sub, errorMessage: null };
    if (code === 'FORBIDDEN') return { state: 'not-operator', sub, errorMessage: null };
    return { state: 'error', sub, errorMessage: whoami.error.message };
  }
  return { state: 'operator', sub, errorMessage: null };
}

/**
 * True when the current session is the platform operator. Loading and every
 * failure state read as "not operator" (fail closed).
 */
export function useIsAdmin(): boolean {
  return useOperatorStatus().state === 'operator';
}
