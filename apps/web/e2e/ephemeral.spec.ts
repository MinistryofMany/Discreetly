import { test, expect, type Page } from '@playwright/test';
import { signIn, resetData, getPrisma, unique } from './harness/helpers.js';

const USER_EMAIL = 'ephemeral-user@example.com';

// Browser RLN proving + WS round-trips are slow; give chat specs more headroom.
test.setTimeout(180_000);

test.beforeAll(async () => {
  await resetData();
});

async function createEphemeralRoom(name: string, slug: string) {
  const db = getPrisma();
  return db.room.create({
    data: {
      name,
      slug,
      rlnIdentifier: String(Date.now()) + String(Math.floor(Math.random() * 1000)),
      // Long epoch window so CI's slow browser proving can't roll the epoch over
      // between proof generation and verification (see chat.spec.ts).
      rateLimit: 3_600_000,
      userMessageLimit: 100,
      visibility: 'PUBLIC',
      encryption: 'PLAINTEXT',
      persistence: 'EPHEMERAL',
      accessPolicy: { allOf: [] },
    },
  });
}

async function enterAndJoin(page: Page, roomId: string, email = USER_EMAIL): Promise<void> {
  await signIn(page, { email, name: email });
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect(page.getByPlaceholder(/type a message/i)).toBeVisible({ timeout: 30_000 });
}

test('ephemeral room: live subscriber sees the message, nothing is persisted, late joiner sees an empty feed', async ({
  browser,
}) => {
  const db = getPrisma();
  const room = await createEphemeralRoom('Ephemeral Lobby', unique('eph-lobby'));

  // Subscriber context connected BEFORE the send: public room is readable and
  // the live subscription is open.
  const subCtx = await browser.newContext();
  const subPage = await subCtx.newPage();
  await subPage.goto(`/rooms/${room.id}`);
  await expect(subPage.getByRole('heading', { name: 'Ephemeral Lobby' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(subPage.getByText('live')).toBeVisible({ timeout: 30_000 });

  // Sender context: join + send a message.
  const sendCtx = await browser.newContext();
  const sendPage = await sendCtx.newPage();
  await enterAndJoin(sendPage, room.id);

  const text = `ephemeral-${Date.now()}`;
  await sendPage.getByPlaceholder(/type a message/i).fill(text);
  await sendPage.getByRole('button', { name: /send message/i }).click();

  // (i) The live subscriber (connected at send time) receives it.
  await expect(subPage.getByText(text)).toBeVisible({ timeout: 60_000 });

  // (ii) No Message row is ever persisted for an ephemeral room. Assert it
  // stays 0 across the polling window (flake-resistant), then a final read.
  await expect
    .poll(() => db.message.count({ where: { roomId: room.id } }), {
      timeout: 3_000,
      intervals: [250, 250, 250],
    })
    .toBe(0);
  expect(await db.message.count({ where: { roomId: room.id } })).toBe(0);

  // (iii) A page that opens the room AFTER the message was sent sees an empty
  // feed: ephemeral rooms keep no history, so there is no backfill.
  const lateCtx = await browser.newContext();
  const latePage = await lateCtx.newPage();
  await latePage.goto(`/rooms/${room.id}`);
  await expect(latePage.getByRole('heading', { name: 'Ephemeral Lobby' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(latePage.getByText('live')).toBeVisible({ timeout: 30_000 });
  // The message sent before this page connected never appears (no history).
  await expect(latePage.getByText(text)).toHaveCount(0);

  await subCtx.close();
  await sendCtx.close();
  await lateCtx.close();
});
