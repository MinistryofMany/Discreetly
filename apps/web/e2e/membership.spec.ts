import { test, expect, type Page } from '@playwright/test';
import { signIn, resetData, subFor, getPrisma, unique } from './harness/helpers.js';
import { joinNullifier } from './harness/gate.js';

const USER_EMAIL = 'member@example.com';

// Browser RLN proving + WS round-trips are slow; give these specs headroom.
test.setTimeout(180_000);

test.beforeAll(async () => {
  await resetData();
});

async function createRoom(opts: { name: string; slug: string }) {
  const db = getPrisma();
  return db.room.create({
    data: {
      name: opts.name,
      slug: opts.slug,
      rlnIdentifier: String(Date.now()) + String(Math.floor(Math.random() * 1000)),
      rateLimit: 3_600_000,
      userMessageLimit: 100,
      visibility: 'PUBLIC',
      encryption: 'PLAINTEXT',
      accessPolicy: { allOf: [] },
    },
  });
}

/**
 * Sign in (the mock delivers the anon branch), open the room so the identity
 * auto-derives, and join. No password, no unlock: the identity is derived per
 * room from the Ministry branch.
 */
async function enterAndJoin(page: Page, roomId: string, email = USER_EMAIL): Promise<void> {
  await signIn(page, { email, name: email });
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect(page.getByPlaceholder(/type a message/i)).toBeVisible({ timeout: 30_000 });
}

test('one leaf per membership: re-entering a joined room never creates a second leaf', async ({
  page,
}) => {
  const db = getPrisma();
  const room = await createRoom({ name: 'Rejoin Room', slug: unique('rejoin') });

  await enterAndJoin(page, room.id);
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);

  // Leave and re-open the room: the identity is DERIVED deterministically from
  // the same branch, so the app recognizes the existing membership and shows the
  // composer straight away (already joined) - never a second Join / second leaf.
  await page.goto('/');
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByPlaceholder(/type a message/i)).toBeVisible({ timeout: 30_000 });
  // The Join affordance is gone (already a member on this deterministic identity).
  await expect(page.getByRole('button', { name: /^join$/i })).toHaveCount(0);
  await expect
    .poll(() => db.membershipLeaf.count({ where: { roomId: room.id } }), {
      timeout: 3_000,
      intervals: [250, 250, 250],
    })
    .toBe(1);
});

test('banned-join: a banned membership cannot join and creates no leaf', async ({ page }) => {
  const db = getPrisma();
  const email = 'banned-user@example.com';
  const room = await createRoom({ name: 'Banned Room', slug: unique('banned') });

  // Seed a BANNED membership keyed by the exact join nullifier the backend will
  // compute for this user in this room: joinNullifier(sub, rlnIdentifier).
  const jn = joinNullifier(subFor(email), BigInt(room.rlnIdentifier)).toString();
  await db.membership.create({
    data: { roomId: room.id, joinNullifier: jn, status: 'BANNED' },
  });

  // Sign in as that user (identity auto-derives) and attempt to join.
  await signIn(page, { email, name: email });
  await page.goto(`/rooms/${room.id}`);
  await page.getByRole('button', { name: /^join$/i }).click();

  // The banned reason is surfaced and no leaf is ever created.
  await expect(page.getByText(/this identity is banned from the room/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(0);
});
