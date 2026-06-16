import { test, expect } from '@playwright/test';

test('home page renders with sign-in when logged out', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Discreetly' })).toBeVisible();
  await expect(page.getByRole('button', { name: /sign in with minister/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Public rooms' })).toBeVisible();
});
