import { test, expect } from '@playwright/test';
import { signIn, resetData, subFor } from './harness/helpers.js';

test.beforeAll(async () => {
  await resetData();
});

test('sign in via mock OIDC shows the anonymous signed-in state, then sign out', async ({ page }) => {
  const email = 'alice@example.com';
  const sub = await signIn(page, { email, name: 'Alice', badges: ['email-domain'] });
  expect(sub).toBe(subFor(email));

  // Home shows the signed-in state but discloses no identifier: the account
  // name and pairwise sub are intentionally never rendered.
  await expect(page.getByText('Signed in.', { exact: true })).toBeVisible();
  await expect(page.getByText(/you are anonymous/i)).toBeVisible();
  await expect(page.getByText('Alice', { exact: true })).toHaveCount(0);
  await expect(page.getByText(`sub: ${sub}`)).toHaveCount(0);

  // Sign out returns to the logged-out state.
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page.getByRole('button', { name: /sign in with minister/i })).toBeVisible();
  await expect(page.getByText('Signed in.', { exact: true })).toHaveCount(0);
});
