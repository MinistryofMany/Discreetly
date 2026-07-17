import { test, expect } from '@playwright/test';
import { signIn, resetData, subFor } from './harness/helpers.js';

/**
 * The identity panel is now READ-ONLY. There is no password vault and no
 * create/unlock/export/import/rotate/remove UI: the anonymous identity is DERIVED
 * per room from the Ministry `#minister_anon` branch delivered at sign-in (see
 * `apps/web/src/lib/identity.ts`). The panel only reports whether that branch is
 * present on this device; the operator sub is shown so it can be allowlisted.
 */
test.beforeAll(async () => {
  await resetData();
});

test('identity panel: reports "Not set up" when signed out', async ({ page }) => {
  await page.goto('/identity');

  await expect(page.getByRole('heading', { name: /your identity/i })).toBeVisible();
  await expect(page.getByText('Not set up', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/sign in with minister to set up your anonymous identity/i),
  ).toBeVisible();

  // No vault affordances survive: no create/unlock/export/import controls.
  await expect(page.getByRole('button', { name: /create identity/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^unlock$/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /export backup/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /import backup/i })).toHaveCount(0);
});

test('identity panel: reports "Ready" and surfaces the operator sub once signed in', async ({
  page,
}) => {
  const email = 'panel@example.com';
  const sub = await signIn(page, { email, name: 'Panel' });
  expect(sub).toBe(subFor(email));

  await page.goto('/identity');

  // The branch was captured at sign-in and adopted: the panel is "Ready" (the
  // identity derives automatically per room, nothing to back up here).
  await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/rooms derive their identity automatically/i)).toBeVisible();

  // The read-only panel still exposes the caller's own Ministry sub (the value an
  // operator adds to DISCREETLY_OPERATOR_SUBS).
  await expect(page.getByText(sub, { exact: false })).toBeVisible();

  // Still no vault controls even when signed in.
  await expect(page.getByRole('button', { name: /create identity/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /rotate device/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /remove from device/i })).toHaveCount(0);
});
