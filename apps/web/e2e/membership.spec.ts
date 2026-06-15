import { test, expect, type Page } from '@playwright/test';
import {
  signIn,
  createIdentity,
  resetData,
  subFor,
  getPrisma,
  unique,
} from './harness/helpers.js';
import { joinNullifier } from './harness/gate.js';

const ID_PASSWORD = 'test-password-123';
const USER_EMAIL = 'rotator@example.com';

// Browser RLN proving + WS round-trips are slow; give these specs headroom.
test.setTimeout(180_000);

test.beforeAll(async () => {
  await resetData();
});

async function createRoom(opts: { name: string; slug: string; maxDevices?: number }) {
  const db = getPrisma();
  return db.room.create({
    data: {
      name: opts.name,
      slug: opts.slug,
      rlnIdentifier: String(Date.now()) + String(Math.floor(Math.random() * 1000)),
      rateLimit: 1000,
      userMessageLimit: 100,
      maxDevices: opts.maxDevices ?? 3,
      visibility: 'PUBLIC',
      encryption: 'PLAINTEXT',
      accessPolicy: { allOf: [] },
    },
  });
}

/** Unlock the stored identity from within a room, waiting for the Join button. */
async function unlockInRoom(page: Page): Promise<void> {
  await page.getByLabel('Password', { exact: true }).fill(ID_PASSWORD);
  await page.getByRole('button', { name: /^unlock$/i }).click();
  await expect(page.getByRole('button', { name: /^join$/i })).toBeVisible({ timeout: 30_000 });
}

/** Sign in, make an identity, open the room, unlock, and join (open policy). */
async function enterAndJoin(page: Page, roomId: string, email = USER_EMAIL): Promise<void> {
  await signIn(page, { email, name: email });
  await createIdentity(page, ID_PASSWORD);
  await page.goto(`/rooms/${roomId}`);
  await unlockInRoom(page);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect(page.getByPlaceholder(/type a message/i)).toBeVisible({ timeout: 30_000 });
}

test('membership.rotate swaps the leaf for the same membership and activates the new identity', async ({
  page,
}) => {
  const db = getPrisma();
  const room = await createRoom({ name: 'Rotate Room', slug: unique('rotate') });

  await enterAndJoin(page, room.id);

  // One leaf exists; capture the original (membership, IC).
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);
  const before = await db.membershipLeaf.findFirstOrThrow({ where: { roomId: room.id } });
  const membership = await db.membership.findFirstOrThrow({ where: { roomId: room.id } });
  const oldIc = before.identityCommitment;

  // Open the Rotate dialog and exercise the Cancel button first.
  await page.getByRole('button', { name: /rotate device/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /rotate device identity/i })).toBeVisible();
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(dialog).toBeHidden();

  // Re-open and rotate for real, exercising the password field + Rotate button.
  await page.getByRole('button', { name: /rotate device/i }).click();
  const dialog2 = page.getByRole('dialog');
  await dialog2.getByLabel(/new encryption password/i).fill('rotated-password-456');
  await dialog2.getByRole('button', { name: /^rotate$/i }).click();
  await expect(page.getByText(/identity rotated for this room/i)).toBeVisible({ timeout: 60_000 });
  await expect(dialog2).toBeHidden();

  // DB truth: still exactly one leaf, under the SAME membership/joinNullifier,
  // but the IC has changed (the old leaf is gone, the new one is present).
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);
  const after = await db.membershipLeaf.findFirstOrThrow({ where: { roomId: room.id } });
  expect(after.membershipId).toBe(membership.id);
  expect(after.identityCommitment).not.toBe(oldIc);
  expect(
    await db.membershipLeaf.count({ where: { roomId: room.id, identityCommitment: oldIc } }),
  ).toBe(0);

  // The local active identity is now the new one: the composer is still shown
  // (the room considers the user joined via the new identity's rateCommitment).
  await expect(page.getByPlaceholder(/type a message/i)).toBeVisible();
});

test('device-limit: a second device join is refused when maxDevices is 1', async ({ page }) => {
  const db = getPrisma();
  const room = await createRoom({ name: 'Solo Room', slug: unique('solo'), maxDevices: 1 });

  // First device joins fine.
  await enterAndJoin(page, room.id);
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);

  // Create a SECOND local identity (overwrites the stored one) for the SAME
  // signed-in user, then return to the room and unlock it.
  await createIdentity(page, ID_PASSWORD);
  await page.goto(`/rooms/${room.id}`);
  await unlockInRoom(page);

  // Joining again hits the room's device limit (same Minister sub => same
  // membership, which already has its one allowed device).
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect(page.getByText(/reached its device limit for you/i)).toBeVisible({
    timeout: 30_000,
  });

  // No second leaf was created.
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);
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

  // Sign in as that user, create an identity, and attempt to join.
  await signIn(page, { email, name: email });
  await createIdentity(page, ID_PASSWORD);
  await page.goto(`/rooms/${room.id}`);
  await unlockInRoom(page);
  await page.getByRole('button', { name: /^join$/i }).click();

  // The banned reason is surfaced and no leaf is ever created.
  await expect(page.getByText(/this identity is banned from the room/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(0);
});
