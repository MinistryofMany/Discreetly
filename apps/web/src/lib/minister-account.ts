import { prisma } from '@discreetly/db';
import type { Account } from 'next-auth';

/**
 * Persist the fresh Minister OAuth tokens onto the existing `Account` row.
 *
 * The Prisma adapter only writes tokens via `linkAccount` (an `account.create`)
 * on the FIRST account-link; on every subsequent sign-in Auth.js core finds the
 * account via `getUserByAccount` and returns without re-persisting, so the
 * originally-stored `id_token` goes stale and is never refreshed. Minister
 * id_tokens are ~10-min-lived with no refresh, so the session callback would
 * keep handing the API a long-expired Bearer forever after the first login.
 *
 * Called from `events.signIn` with the fresh `account` from the token endpoint,
 * this updates the persisted row's token columns so a fresh login always yields
 * a fresh `session.idToken`. Matches the exact column set the adapter's
 * `linkAccount` writes. Returns the number of rows updated (0 if the row does
 * not yet exist, which never happens post-`handleLoginOrRegister`).
 */
export async function refreshMinisterAccountTokens(account: Account): Promise<number> {
  const { provider, providerAccountId } = account;
  const { count } = await prisma.account.updateMany({
    where: { provider, providerAccountId },
    data: {
      id_token: account.id_token ?? null,
      access_token: account.access_token ?? null,
      refresh_token: account.refresh_token ?? null,
      expires_at: account.expires_at ?? null,
      token_type: account.token_type ?? null,
      scope: account.scope ?? null,
      session_state:
        typeof account.session_state === 'string' ? account.session_state : null,
    },
  });
  return count;
}
