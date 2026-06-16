import { test, expect, type Page } from '@playwright/test';
import {
  signIn,
  createIdentity,
  resetData,
  seedAdmin,
  subFor,
  getPrisma,
  unique,
} from './harness/helpers.js';
import { API_URL } from './harness/env.js';

const USER_EMAIL = 'chatter@example.com';
const ADMIN_EMAIL = 'admin@example.com';

// Browser RLN proving + WS round-trips are slow; give chat specs more headroom.
test.setTimeout(180_000);

test.beforeAll(async () => {
  await resetData();
  await seedAdmin(subFor(ADMIN_EMAIL));
});

async function createRoom(opts: {
  name: string;
  slug: string;
  visibility?: 'PUBLIC' | 'PRIVATE';
  encryption?: 'PLAINTEXT' | 'AES';
  userMessageLimit?: number;
  rateLimit?: number;
}) {
  const db = getPrisma();
  return db.room.create({
    data: {
      name: opts.name,
      slug: opts.slug,
      rlnIdentifier: String(Date.now()) + String(Math.floor(Math.random() * 1000)),
      // Long epoch window by default: in CI, browser RLN proving takes several
      // seconds, so a short (e.g. 1s) window would roll the epoch over between
      // proof generation and server verification, getting the proof rejected.
      // Specs that exercise rate limiting set their own value.
      rateLimit: opts.rateLimit ?? 3_600_000,
      userMessageLimit: opts.userMessageLimit ?? 100,
      visibility: opts.visibility ?? 'PUBLIC',
      encryption: opts.encryption ?? 'PLAINTEXT',
      accessPolicy: { allOf: [] },
    },
  });
}

const ID_PASSWORD = 'test-password-123';

/**
 * Unlock the stored identity from within a room (the in-memory unlock does not
 * survive a full-page navigation, so the room embeds its own identity panel).
 */
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
  // After joining, the composer appears.
  await expect(page.getByPlaceholder(/type a message/i)).toBeVisible({ timeout: 30_000 });
}

test('join an open room, send an RLN message, see it over the live feed', async ({ page }) => {
  const db = getPrisma();
  const room = await createRoom({ name: 'Lobby', slug: unique('lobby') });

  await enterAndJoin(page, room.id);

  // A leaf (membership) now exists for this room.
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);

  const text = `hello-${Date.now()}`;
  await page.getByPlaceholder(/type a message/i).fill(text);
  await page.getByRole('button', { name: /send message/i }).click();

  // The message arrives back over the message.subscribe feed and is persisted.
  await expect(page.getByText(text)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => db.message.count({ where: { roomId: room.id } })).toBeGreaterThan(0);
});

test('per-epoch rate limit blocks a second send in the same window', async ({ page }) => {
  const db = getPrisma();
  // userMessageLimit 1 + a long epoch window => the 2nd send hits the cap.
  const room = await createRoom({
    name: 'Slowpoke',
    slug: unique('slow'),
    userMessageLimit: 1,
    rateLimit: 3_600_000,
  });

  await enterAndJoin(page, room.id);

  await page.getByPlaceholder(/type a message/i).fill('first');
  await page.getByRole('button', { name: /send message/i }).click();
  await expect(page.getByText('first')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => db.message.count({ where: { roomId: room.id } })).toBe(1);

  // Second send in the same epoch is refused client-side (no new proof/message).
  await page.getByPlaceholder(/type a message/i).fill('second');
  await page.getByRole('button', { name: /send message/i }).click();
  await expect(page.getByText(/rate limit reached for this epoch/i)).toBeVisible();
  // No second message is ever persisted: the count must stay at exactly 1 for
  // the whole polling window (a flake-resistant "stays 1" rather than a sleep).
  await expect
    .poll(() => db.message.count({ where: { roomId: room.id } }), {
      timeout: 3_000,
      intervals: [250, 250, 250],
    })
    .toBe(1);
  expect(await db.message.count({ where: { roomId: room.id } })).toBe(1);
});

test('AES room: encrypted send round-trips to decrypted text', async ({ page }) => {
  const room = await createRoom({
    name: 'Secret',
    slug: unique('secret'),
    encryption: 'AES',
  });

  await signIn(page, { email: USER_EMAIL, name: USER_EMAIL });
  await createIdentity(page, ID_PASSWORD);
  await page.goto(`/rooms/${room.id}`);

  // Unlock the room with its password (derives the AES key client-side).
  await page.getByLabel(/enter the room password/i).fill('room-secret');
  await page.getByRole('button', { name: /unlock room/i }).click();

  // Unlock the identity (embedded panel), then join and send.
  await unlockInRoom(page);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect(page.getByPlaceholder(/type a message/i)).toBeVisible({ timeout: 30_000 });

  const text = `cipher-${Date.now()}`;
  await page.getByPlaceholder(/type a message/i).fill(text);
  await page.getByRole('button', { name: /send message/i }).click();
  await expect(page.getByText(text)).toBeVisible({ timeout: 60_000 });

  // The persisted content is an encrypted envelope, not the plaintext.
  const db = getPrisma();
  await expect.poll(() => db.message.count({ where: { roomId: room.id } })).toBeGreaterThan(0);
  const msg = await db.message.findFirstOrThrow({ where: { roomId: room.id } });
  expect(msg.content).not.toContain(text);
});

test('private room read is gated: non-member is blocked', async ({ page }) => {
  const room = await createRoom({
    name: 'Members Only',
    slug: unique('private'),
    visibility: 'PRIVATE',
  });

  // Signed in but never joined => the room read is forbidden.
  await signIn(page, { email: 'outsider@example.com', name: 'Outsider' });
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByRole('heading', { name: 'Private room' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/you must be a member to view it/i)).toBeVisible();
});

test('id_token never appears in a request URL (room reads use POST + header)', async ({
  page,
}) => {
  const room = await createRoom({ name: 'No-Leak', slug: unique('noleak') });

  // Capture every request URL the page makes while authenticated and browsing.
  const urls: string[] = [];
  page.on('request', (req) => urls.push(req.url()));

  await signIn(page, { email: USER_EMAIL, name: USER_EMAIL });
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByRole('heading', { name: 'No-Leak' })).toBeVisible({ timeout: 30_000 });
  // Let the room.get / room.leaves / message.list queries fire.
  await page.waitForTimeout(1_000);

  // The bearer id_token is only ever attached to API (tRPC) requests, so only
  // those URLs could leak it. (The NextAuth OIDC callback carries its own JWE
  // `state` param, which is expected and unrelated to the id_token.) Assert no
  // tRPC request URL contains a JWT or an id_token query param - they go in the
  // POST body / Authorization header instead.
  const apiUrls = urls.filter((u) => u.startsWith(API_URL));
  expect(apiUrls.length, 'expected at least one tRPC request').toBeGreaterThan(0);
  const leaked = apiUrls.filter(
    (u) => /eyJ[A-Za-z0-9_-]+\./.test(u) || /id[_-]?token/i.test(u),
  );
  expect(leaked, `tRPC URLs leaking a token:\n${leaked.join('\n')}`).toEqual([]);
});

test('admin broadcast reaches a chat subscriber as a system message', async ({ browser }) => {
  const db = getPrisma();
  const room = await createRoom({ name: 'Townhall', slug: unique('townhall') });

  // Subscriber context: open the room (public => readable, subscription live).
  const subCtx = await browser.newContext();
  const subPage = await subCtx.newPage();
  await subPage.goto(`/rooms/${room.id}`);
  await expect(subPage.getByRole('heading', { name: 'Townhall' })).toBeVisible({ timeout: 30_000 });
  // Wait for the WS subscription to be live.
  await expect(subPage.getByText('live')).toBeVisible({ timeout: 30_000 });

  // Admin context: send a broadcast to the room.
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await signIn(adminPage, { email: ADMIN_EMAIL, name: 'Admin' });
  await adminPage.goto('/admin');
  await adminPage.getByRole('tab', { name: 'Broadcast' }).click();
  await adminPage.getByRole('combobox').click();
  await adminPage.getByRole('option', { name: 'Townhall' }).click();
  const broadcastText = `notice-${Date.now()}`;
  await adminPage.getByPlaceholder(/enter broadcast message/i).fill(broadcastText);
  await adminPage.getByRole('button', { name: /send broadcast/i }).click();
  await expect(adminPage.getByText('Broadcast sent')).toBeVisible();

  // The subscriber receives it as a system message; it is also audited.
  await expect(subPage.getByText(broadcastText)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => db.auditLog.count({ where: { action: 'SYSTEM_BROADCAST', target: room.id } }))
    .toBeGreaterThan(0);

  await subCtx.close();
  await adminCtx.close();
});
