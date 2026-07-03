// @vitest-environment node
/**
 * DB-backed test for the sign-in id_token refresh. The Prisma adapter persists
 * the Minister id_token onto the `Account` row only at first account-link and
 * never again, so `refreshMinisterAccountTokens` must overwrite the stored
 * token with the fresh one supplied on every subsequent sign-in. Without this,
 * the session callback keeps handing the API a long-expired Bearer forever
 * after a user's first login. Runs against the real dev Postgres (like
 * room-auth.test.ts); rows are namespaced and cleaned up.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import type { Account } from 'next-auth';
import { prisma } from '@discreetly/db';
import { refreshMinisterAccountTokens } from './minister-account.js';

const TAG = `minister-acct-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const provider = 'minister';
const providerAccountId = `${TAG}-paid`;
let userId: string;

function account(overrides: Partial<Account>): Account {
  return {
    provider,
    providerAccountId,
    type: 'oidc',
    ...overrides,
  } as Account;
}

beforeAll(async () => {
  await prisma.$queryRawUnsafe('SELECT 1');
  const user = await prisma.user.create({ data: { name: TAG } });
  userId = user.id;
  // Simulate the adapter's first-link `account.create` with a now-stale token.
  await prisma.account.create({
    data: {
      userId,
      type: 'oidc',
      provider,
      providerAccountId,
      id_token: 'stale.first.token',
      access_token: 'stale-access',
      expires_at: 1000,
      token_type: 'Bearer',
      scope: 'openid profile',
    },
  });
});

afterAll(async () => {
  await prisma.account.deleteMany({ where: { providerAccountId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('refreshMinisterAccountTokens', () => {
  it('overwrites the stored id_token with the fresh one on re-sign-in', async () => {
    const count = await refreshMinisterAccountTokens(
      account({
        id_token: 'fresh.second.token',
        access_token: 'fresh-access',
        expires_at: 2000,
        token_type: 'bearer',
        scope: 'openid profile',
      }),
    );
    expect(count).toBe(1);

    const row = await prisma.account.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId } },
      select: { id_token: true, access_token: true, expires_at: true },
    });
    expect(row?.id_token).toBe('fresh.second.token');
    expect(row?.access_token).toBe('fresh-access');
    expect(row?.expires_at).toBe(2000);
  });

  it('nulls a token field when the fresh account omits it', async () => {
    await refreshMinisterAccountTokens(account({ id_token: 'third.token' }));
    const row = await prisma.account.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId } },
      select: { id_token: true, access_token: true },
    });
    expect(row?.id_token).toBe('third.token');
    expect(row?.access_token).toBeNull();
  });

  it('is a no-op (0 rows) for an unknown account', async () => {
    const count = await refreshMinisterAccountTokens(
      account({ providerAccountId: `${TAG}-missing`, id_token: 'x' }),
    );
    expect(count).toBe(0);
  });
});
