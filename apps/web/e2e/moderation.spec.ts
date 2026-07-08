import { test, expect, type Page } from '@playwright/test';
import {
  signIn,
  createIdentity,
  resetData,
  getPrisma,
  unique,
} from './harness/helpers.js';

/**
 * Per-room history cap. Must match `MAX_ROOM_MESSAGES` in
 * `services/api/src/messaging/history.ts`. Kept as a local literal so this spec
 * does not import the api server entry at runtime (which would pull its
 * Node-only graph through Playwright's TS loader).
 */
const MAX_ROOM_MESSAGES = 1000;

const USER_EMAIL = 'chatter@example.com';
const ADMIN_EMAIL = 'admin@example.com';
const ID_PASSWORD = 'test-password-123';

// Browser RLN proving + WS round-trips are slow; give moderation specs headroom.
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
      // Long epoch window so a browser proof does not straddle an epoch roll.
      rateLimit: 3_600_000,
      userMessageLimit: 100,
      visibility: 'PUBLIC',
      encryption: 'PLAINTEXT',
      persistence: 'PERSISTENT',
      accessPolicy: { allOf: [] },
    },
  });
}

async function unlockInRoom(page: Page): Promise<void> {
  await page.getByLabel('Password', { exact: true }).fill(ID_PASSWORD);
  await page.getByRole('button', { name: /^unlock$/i }).click();
  await expect(page.getByRole('button', { name: /^join$/i })).toBeVisible({ timeout: 30_000 });
}

async function enterAndJoin(page: Page, roomId: string, email: string): Promise<void> {
  await signIn(page, { email, name: email });
  await createIdentity(page, ID_PASSWORD);
  await page.goto(`/rooms/${roomId}`);
  await unlockInRoom(page);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect(page.getByPlaceholder(/type a message/i)).toBeVisible({ timeout: 30_000 });
}

test('operator soft-deletes a message: it renders as a tombstone in place and the row is retained', async ({
  page,
}) => {
  const db = getPrisma();
  const room = await createRoom({ name: 'ModRoom', slug: unique('mod') });

  // The ADMIN is also the chatter here: they join, send a message, then (as the
  // operator) remove it. The operator-only "remove" control appears for admins.
  await enterAndJoin(page, room.id, ADMIN_EMAIL);

  const text = `bad-${Date.now()}`;
  await page.getByPlaceholder(/type a message/i).fill(text);
  await page.getByRole('button', { name: /send message/i }).click();
  await expect(page.getByText(text)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => db.message.count({ where: { roomId: room.id } })).toBe(1);

  const stored = await db.message.findFirstOrThrow({ where: { roomId: room.id } });

  // The stock client attached its recorded join nullifier and the pipeline
  // validated it against the membership: the author link is persisted (this
  // is what admin.banMessageAuthor resolves server-side).
  expect(stored.senderJoinNullifier).not.toBeNull();
  const authorMembership = await db.membership.findFirst({
    where: { roomId: room.id, joinNullifier: stored.senderJoinNullifier! },
  });
  expect(authorMembership).not.toBeNull();

  // Operator removes the message via the in-feed control.
  await page.getByRole('button', { name: /remove message/i }).click();

  // The feed re-renders the row in place as the operator marker; the original
  // content is gone from the DOM.
  await expect(page.getByText('removed by operator')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(text)).toHaveCount(0);

  // DB truth: the row is RETAINED (count unchanged) and tombstoned — content
  // purged, deletedAt/deletedBy set, RLN accounting fields preserved.
  expect(await db.message.count({ where: { roomId: room.id } })).toBe(1);
  await expect
    .poll(async () => (await db.message.findUniqueOrThrow({ where: { id: stored.id } })).content)
    .toBe('');
  const after = await db.message.findUniqueOrThrow({ where: { id: stored.id } });
  expect(after.deletedAt).not.toBeNull();
  expect(after.deletedBy).not.toBeNull();
  expect(after.rlnNullifier).toBe(stored.rlnNullifier); // RLN nullifier retained
  expect(after.epoch).toBe(stored.epoch); // epoch retained
  expect(after.proof).not.toBeNull(); // proof retained (slashing intact)

  // An audit row records the operator action.
  await expect
    .poll(() => db.auditLog.count({ where: { action: 'MESSAGE_DELETE', target: room.id } }))
    .toBe(1);

  // A reload shows the tombstone from history backfill (message.list), not the
  // original content.
  await page.reload();
  await expect(page.getByText('removed by operator')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(text)).toHaveCount(0);
});

test('non-operator never sees the remove control', async ({ page }) => {
  const room = await createRoom({ name: 'NoMod', slug: unique('nomod') });
  await enterAndJoin(page, room.id, USER_EMAIL);

  const text = `keep-${Date.now()}`;
  await page.getByPlaceholder(/type a message/i).fill(text);
  await page.getByRole('button', { name: /send message/i }).click();
  await expect(page.getByText(text)).toBeVisible({ timeout: 60_000 });

  // No operator "remove" affordance is rendered for a non-operator.
  await expect(page.getByRole('button', { name: /remove message/i })).toHaveCount(0);
});

test('posting past the cap prunes the oldest; tombstoned rows still occupy a slot', async ({
  page,
}) => {
  const db = getPrisma();
  const room = await createRoom({ name: 'RingRoom', slug: unique('ring') });

  // Seed the room to exactly the cap via the DB (cheap, no browser proving). The
  // oldest seeded row is a TOMBSTONE, so we prove a tombstone still occupies a
  // slot and is the one pruned when a newer real message arrives.
  const base = new Date('2026-01-01T00:00:00.000Z').getTime();
  const oldestId = `seed-oldest-${Date.now()}`;
  await db.message.create({
    data: {
      id: oldestId,
      roomId: room.id,
      epoch: 1n,
      rlnNullifier: `seed-nf-oldest-${Date.now()}`,
      content: '', // tombstoned: purged content
      proof: { snarkProof: { publicSignals: { x: '1', y: '2' } } },
      createdAt: new Date(base),
      deletedAt: new Date(base),
      deletedBy: 'op',
    },
  });
  // Fill the rest of the cap with live rows, all older than "now".
  const bulk = Array.from({ length: MAX_ROOM_MESSAGES - 1 }, (_, i) => ({
    roomId: room.id,
    epoch: BigInt(i + 2),
    rlnNullifier: `seed-nf-${Date.now()}-${i}`,
    content: `seed-${i}`,
    proof: { snarkProof: { publicSignals: { x: `${i}`, y: `${i}` } } } as object,
    createdAt: new Date(base + (i + 1) * 1000),
  }));
  await db.message.createMany({ data: bulk });

  expect(await db.message.count({ where: { roomId: room.id } })).toBe(MAX_ROOM_MESSAGES);
  // The tombstoned oldest row is present and counts toward the cap.
  expect(await db.message.findUnique({ where: { id: oldestId } })).not.toBeNull();

  // A real user joins and sends ONE message through the live pipeline, which
  // triggers the on-write prune (cap + 1 -> cap).
  await enterAndJoin(page, room.id, USER_EMAIL);
  const text = `fresh-${Date.now()}`;
  await page.getByPlaceholder(/type a message/i).fill(text);
  await page.getByRole('button', { name: /send message/i }).click();
  await expect(page.getByText(text)).toBeVisible({ timeout: 60_000 });

  // The room caps at MAX_ROOM_MESSAGES (not cap+1): the prune removed the oldest.
  await expect
    .poll(() => db.message.count({ where: { roomId: room.id } }))
    .toBe(MAX_ROOM_MESSAGES);
  // The oldest (tombstoned) row is the one pruned.
  await expect
    .poll(() => db.message.findUnique({ where: { id: oldestId } }))
    .toBeNull();
  // The fresh message is retained.
  expect(
    await db.message.count({ where: { roomId: room.id, content: text } }),
  ).toBe(1);
});
