/**
 * Spec-side helpers for the one-root anonymous-identity model.
 *
 * The app DERIVES a room's Semaphore identity from the Ministry `#minister_anon`
 * branch delivered on the OIDC callback (see `apps/web/src/lib/identity.ts` and
 * the SDK `@ministryofmany/identity`). To assert the branch survived the callback
 * chain to the EXPECTED identity (not merely that some identity exists), a test
 * recomputes that identity from the SAME deterministic branch the mock issuer
 * delivered - reusing the app's own `deriveRoomIdentity` so the derivation can
 * never drift from what the browser did.
 */
import { createTRPCClient, httpLink } from '@trpc/client';
import type { AppRouter } from '@discreetly/api';
import { deriveRoomIdentity } from '../../src/lib/identity.js';
import { branchForSub, subFor } from '../mock-oidc/issuer.js';
import { API_URL, MOCK_ISSUER } from './env.js';

/**
 * The identity commitment the app WILL derive for `email` in `roomId` at the
 * given anon epoch, computed from the exact branch the mock issuer delivered.
 * `deriveRoomIdentity` is the app's own derivation, so this matches byte-for-byte
 * what the browser stores in a `MembershipLeaf`.
 */
export async function expectedCommitment(
  email: string,
  roomId: string,
  epoch = 1,
): Promise<string> {
  const branch = branchForSub(subFor(email), epoch);
  try {
    const identity = await deriveRoomIdentity(branch, roomId);
    return identity.commitment.toString();
  } finally {
    branch.fill(0);
  }
}

/**
 * Mint a fresh id_token for `sub` at `epoch` from the RUNNING mock issuer (signed
 * by the key the API verifier trusts). Used to authorize the epoch-gated re-key.
 */
export async function mintTestToken(sub: string, epoch: number): Promise<string> {
  const res = await fetch(
    `${MOCK_ISSUER}/test/id-token?sub=${encodeURIComponent(sub)}&epoch=${epoch}`,
  );
  if (!res.ok) throw new Error(`mint test token failed: ${res.status}`);
  const body = (await res.json()) as { id_token: string };
  return body.id_token;
}

/**
 * Drive the API's epoch-gated `membership.rotate` primitive directly (the app
 * ships no browser rotate control): the Ministry re-key that swaps a room's leaf
 * in place. Full cross-boundary path - mock-issued token -> API verify -> gate ->
 * epoch-gated swap -> DB - just without a UI trigger the app does not expose.
 */
export async function rotateMembership(input: {
  roomId: string;
  idToken: string;
  newIdentityCommitment: string;
}): Promise<{ ok: boolean; reason?: string; rateCommitment?: string }> {
  const client = createTRPCClient<AppRouter>({ links: [httpLink({ url: API_URL })] });
  return client.membership.rotate.mutate(input);
}
