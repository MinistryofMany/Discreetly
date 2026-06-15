import { test, expect } from '@playwright/test';
import { signIn, resetData, subFor } from './harness/helpers.js';

test.beforeAll(async () => {
  await resetData();
});

test('sign in via mock OIDC shows the user, then sign out', async ({ page }) => {
  const email = 'alice@example.com';
  const sub = await signIn(page, { email, name: 'Alice', badges: ['email-domain'] });
  expect(sub).toBe(subFor(email));

  // Home shows the signed-in user and pairwise sub.
  await expect(page.getByText('Alice', { exact: true })).toBeVisible();
  await expect(page.getByText(`sub: ${sub}`)).toBeVisible();

  // Sign out returns to the logged-out state.
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page.getByRole('button', { name: /sign in with minister/i })).toBeVisible();
  await expect(page.getByText(/sign in with minister to join rooms/i)).toBeVisible();
});
