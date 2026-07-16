import { test, expect, type Locator } from '@playwright/test';
import { signIn, resetData, subFor, getPrisma, unique } from './harness/helpers.js';

/** Fill the input whose containing div holds a <label> with the given text. */
function fieldByLabel(scope: Locator, label: string): Locator {
  return scope.locator(`div:has(> label:text-is("${label}")) input`);
}

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_SUB = subFor(ADMIN_EMAIL);

// The operator allowlist is boot-time env (DISCREETLY_OPERATOR_SUBS, set to
// this admin's sub in harness/servers.ts) - nothing to seed in the DB.
test.beforeAll(async () => {
  await resetData();
});

test('non-admin is not authorized at /admin', async ({ page }) => {
  await signIn(page, { email: 'nobody@example.com', name: 'Nobody' });
  await page.goto('/admin');
  await expect(page.getByText('not an operator', { exact: false })).toBeVisible();
  // The gate surfaces the caller's own sub so an operator can allowlist it.
  await expect(page.getByText(subFor('nobody@example.com'))).toBeVisible();
});

test('admin: create (open + custom policy), edit, delete room', async ({ page }) => {
  await signIn(page, { email: ADMIN_EMAIL, name: 'Admin' });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Admin dashboard' })).toBeVisible();

  const db = getPrisma();

  // --- Create with the Open-policy shortcut ---
  const openSlug = unique('open');
  await page.getByRole('button', { name: /\+ create room/i }).click();
  const dialog = page.getByRole('dialog');
  await fieldByLabel(dialog, 'Name').fill('Open Room');
  await fieldByLabel(dialog, 'Slug').fill(openSlug);
  // Default form already uses the open policy.
  await dialog.getByRole('button', { name: /create room/i }).click();
  // Dialog closes on success; assert DB truth (more robust than a toast race).
  await expect(dialog).toBeHidden();
  await expect.poll(() => db.room.count({ where: { slug: openSlug } })).toBe(1);

  const openRoom = await db.room.findUniqueOrThrow({ where: { slug: openSlug } });
  expect(openRoom.accessPolicy).toEqual({ allOf: [] });
  expect(openRoom.visibility).toBe('PUBLIC');

  // --- Create with a custom policy built in the boolean builder ---
  const gatedSlug = unique('gated');
  await page.getByRole('button', { name: /\+ create room/i }).click();
  const dialog2 = page.getByRole('dialog');
  await fieldByLabel(dialog2, 'Name').fill('Gated Room');
  await fieldByLabel(dialog2, 'Slug').fill(gatedSlug);
  await dialog2.getByRole('button', { name: /build custom policy/i }).click();
  // Root is allOf; add a badge leaf (defaults to email-domain).
  await dialog2.getByRole('button', { name: /^\+ badge$/i }).click();
  await expect(dialog2.getByText('badge', { exact: true })).toBeVisible();
  await dialog2.getByRole('button', { name: /create room/i }).click();
  await expect(dialog2).toBeHidden();
  await expect.poll(() => db.room.count({ where: { slug: gatedSlug } })).toBe(1);

  const gatedRoom = await db.room.findUniqueOrThrow({ where: { slug: gatedSlug } });
  expect(gatedRoom.accessPolicy).toEqual({
    allOf: [{ badge: { type: 'email-domain' } }],
  });

  // --- Edit the gated room's name ---
  const row = page.getByRole('row', { name: new RegExp(gatedSlug) });
  await row.getByRole('button', { name: /^edit$/i }).click();
  const editDialog = page.getByRole('dialog');
  await fieldByLabel(editDialog, 'Name').fill('Gated Room Renamed');
  await editDialog.getByRole('button', { name: /save changes/i }).click();
  await expect(editDialog).toBeHidden();
  await expect
    .poll(async () => (await db.room.findUniqueOrThrow({ where: { slug: gatedSlug } })).name)
    .toBe('Gated Room Renamed');

  // --- Delete the open room ---
  const openRow = page.getByRole('row', { name: new RegExp(openSlug) });
  await openRow.getByRole('button', { name: /^delete$/i }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^delete$/i })
    .click();
  await expect.poll(() => db.room.count({ where: { slug: openSlug } })).toBe(0);
});

test('admin: ban by IC, ban by join-nullifier, unban, inspect members', async ({ page }) => {
  const db = getPrisma();

  // Seed a room with one ACTIVE membership + leaf directly in the DB.
  const slug = unique('banroom');
  const room = await db.room.create({
    data: {
      name: 'Ban Room',
      slug,
      rlnIdentifier: String(Date.now()) + '01',
      rateLimit: 10000,
      userMessageLimit: 5,
      accessPolicy: { allOf: [] },
    },
  });
  const ic = '111222333444';
  const jn = '999888777666';
  const { getRateCommitmentHash } = await import('@ministryofmany/rln');
  const rateCommitment = getRateCommitmentHash(BigInt(ic), 5).toString();
  await db.membership.create({
    data: {
      roomId: room.id,
      joinNullifier: jn,
      status: 'ACTIVE',
      leaves: {
        create: {
          roomId: room.id,
          identityCommitment: ic,
          rateCommitment,
        },
      },
    },
  });

  await signIn(page, { email: ADMIN_EMAIL, name: 'Admin' });
  await page.goto('/admin');

  // Members tab: pick the room, see the membership + leaf.
  await page.getByRole('tab', { name: 'Members' }).click();
  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Ban Room' }).click();
  await expect(page.getByText(`jn: ${jn}`)).toBeVisible();
  await expect(page.getByText(`IC: ${ic}`)).toBeVisible();
  await expect(page.getByText('ACTIVE')).toBeVisible();

  // Ban by IC from the Bans tab.
  await page.getByRole('tab', { name: 'Bans' }).click();
  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Ban Room' }).click();
  const banIcSection = page.locator('section:has(h3:text-is("Ban by identity commitment"))');
  const banJnSection = page.locator('section:has(h3:text-is("Ban by join nullifier"))');
  const unbanSection = page.locator('section:has(h3:text-is("Unban by join nullifier"))');

  await banIcSection.getByPlaceholder(/identity commitment/i).fill(ic);
  await banIcSection.getByRole('button', { name: /^ban$/i }).click();
  await expect(page.getByText('Banned by identity commitment')).toBeVisible();
  await expect.poll(async () => db.ban.count({ where: { roomId: room.id } })).toBeGreaterThan(0);
  await expect
    .poll(async () => (await db.membership.findFirstOrThrow({ where: { roomId: room.id } })).status)
    .toBe('BANNED');

  // Unban by join-nullifier.
  await unbanSection.getByPlaceholder(/join nullifier/i).fill(jn);
  await unbanSection.getByRole('button', { name: /^unban$/i }).click();
  await expect(page.getByText('Unbanned')).toBeVisible();
  await expect
    .poll(async () => (await db.membership.findFirstOrThrow({ where: { roomId: room.id } })).status)
    .toBe('ACTIVE');

  // Ban by join-nullifier.
  await banJnSection.getByPlaceholder(/join nullifier/i).fill(jn);
  await banJnSection.getByRole('button', { name: /^ban$/i }).click();
  await expect(page.getByText('Banned by join nullifier')).toBeVisible();
  await expect
    .poll(async () => (await db.membership.findFirstOrThrow({ where: { roomId: room.id } })).status)
    .toBe('BANNED');
});

test('admin: audit log reflects own actions and filters', async ({ page }) => {
  const db = getPrisma();
  await signIn(page, { email: ADMIN_EMAIL, name: 'Admin' });
  await page.goto('/admin');

  // Create a room to generate a ROOM_CREATE audit row.
  const slug = unique('auditroom');
  await page.getByRole('button', { name: /\+ create room/i }).click();
  const dialog = page.getByRole('dialog');
  await fieldByLabel(dialog, 'Name').fill('Audit Room');
  await fieldByLabel(dialog, 'Slug').fill(slug);
  await dialog.getByRole('button', { name: /create room/i }).click();
  await expect(page.getByText('Room created')).toBeVisible();
  const room = await db.room.findUniqueOrThrow({ where: { slug } });

  // Audit tab: filter by action ROOM_CREATE and assert the row appears.
  await page.getByRole('tab', { name: 'Audit' }).click();
  await page.getByPlaceholder(/e\.g\. ROOM_CREATE/i).fill('ROOM_CREATE');
  await page.getByRole('button', { name: /^refresh$/i }).click();
  const auditRow = page.getByRole('row', { name: new RegExp(room.id) });
  await expect(auditRow.first()).toBeVisible();
  await expect(auditRow.first().getByText('ROOM_CREATE')).toBeVisible();
  await expect(auditRow.first().getByText(ADMIN_SUB)).toBeVisible();

  // Filtering by a non-matching action hides it.
  await page.getByPlaceholder(/e\.g\. ROOM_CREATE/i).fill('NOPE_NONE');
  await page.getByRole('button', { name: /^refresh$/i }).click();
  await expect(page.getByText(/no audit entries match/i)).toBeVisible();
});
