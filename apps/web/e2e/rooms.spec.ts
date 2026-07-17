import { test, expect } from '@playwright/test';
import { signIn, resetData, getPrisma, unique } from './harness/helpers.js';

test.beforeAll(async () => {
  await resetData();
});

async function createRoom(opts: { name: string; slug: string; accessPolicy?: unknown }) {
  const db = getPrisma();
  return db.room.create({
    data: {
      name: opts.name,
      slug: opts.slug,
      rlnIdentifier: String(Date.now()) + String(Math.floor(Math.random() * 1000)),
      rateLimit: 1000,
      userMessageLimit: 100,
      accessPolicy: (opts.accessPolicy ?? { allOf: [] }) as object,
    },
  });
}

test('home lists public rooms with eligibility hints and navigates in', async ({ page }) => {
  const openRoom = await createRoom({ name: 'Open Lounge', slug: unique('lounge') });
  await createRoom({
    name: 'Gated Hall',
    slug: unique('hall'),
    accessPolicy: { allOf: [{ badge: { type: 'email-domain' } }] },
  });

  await page.goto('/');

  // Both rooms render from room.listPublic.
  await expect(page.getByText('Open Lounge')).toBeVisible();
  await expect(page.getByText('Gated Hall')).toBeVisible();

  // Eligibility hints: the open room shows "open"; the gated one needs a badge.
  const openCard = page.locator('li', { hasText: 'Open Lounge' });
  await expect(openCard.getByText('open', { exact: true })).toBeVisible();
  const gatedCard = page.locator('li', { hasText: 'Gated Hall' });
  await expect(gatedCard.getByText('badges required')).toBeVisible();

  // Navigate into the open room.
  await page.getByText('Open Lounge').click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${openRoom.id}$`));
  await expect(page.getByRole('heading', { name: 'Open Lounge' })).toBeVisible();
});

test('badge-gated room: join blocked without the badge, succeeds after disclosing it', async ({
  browser,
}) => {
  const db = getPrisma();
  const room = await createRoom({
    name: 'Domain Club',
    slug: unique('domain'),
    accessPolicy: { allOf: [{ badge: { type: 'email-domain' } }] },
  });

  // --- Without the badge: the identity derives, but Join is inert (disabled) and
  // the primary action is the per-room disclosure CTA, so a user can no longer
  // walk into a policy-denied join. (Server-side deny stays covered by the API
  // gate tests.)
  const noBadgeCtx = await browser.newContext();
  const noBadgePage = await noBadgeCtx.newPage();
  await signIn(noBadgePage, { email: 'nobadge@example.com', name: 'No Badge' });
  await noBadgePage.goto(`/rooms/${room.id}`);
  await expect(noBadgePage.getByRole('button', { name: /^join$/i })).toBeDisabled();
  await expect(
    noBadgePage.getByRole('button', { name: /disclose badges for this room/i }),
  ).toBeVisible();
  expect(await db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(0);
  await noBadgeCtx.close();

  // --- With the email-domain badge disclosed at sign-in, the derived identity
  // joins. (The mock issuer discloses the checked badge on the consent form, so
  // the session token carries email-domain and the gate admits.)
  const memberCtx = await browser.newContext();
  const memberPage = await memberCtx.newPage();
  await signIn(memberPage, {
    email: 'member@example.com',
    name: 'Member',
    badges: ['email-domain'],
  });
  await memberPage.goto(`/rooms/${room.id}`);
  await memberPage.getByRole('button', { name: /^join$/i }).click();
  await expect(memberPage.getByPlaceholder(/type a message/i)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);
  await memberCtx.close();
});
