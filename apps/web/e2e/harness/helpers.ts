/**
 * Spec-side helpers: drive the mock OIDC sign-in through Auth.js, read/seed DB
 * truth, and mint unique slugs/subs so specs are independent.
 */
import { expect, type Page } from '@playwright/test';
import { getPrisma, seedAdmin, resetData } from './db.js';
import { subFor } from '../mock-oidc/issuer.js';

export { getPrisma, seedAdmin, resetData, subFor };

let counter = 0;
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export interface SignInOptions {
  email: string;
  name?: string;
  /** Badge catalog keys to disclose, e.g. ['email-domain','age-over-18']. */
  badges?: string[];
}

/**
 * Sign in via the mock Minister OIDC issuer. Clicks the in-app sign-in button
 * (Auth.js handles CSRF + PKCE/state/nonce), fills the mock consent form, and
 * waits for the session to land back on the app. Returns the pairwise sub.
 */
export async function signIn(page: Page, opts: SignInOptions): Promise<string> {
  await page.goto('/');
  await page
    .getByRole('button', { name: /sign in with minister/i })
    .first()
    .click();

  // Mock consent page.
  await page.waitForURL(/\/oidc\/authorize/, { timeout: 30_000 });
  await page.locator('#email').fill(opts.email);
  if (opts.name) await page.locator('#name').fill(opts.name);
  for (const badge of opts.badges ?? []) {
    await page.locator(`input[name="badge"][value="${badge}"]`).check();
  }
  await page.locator('#approve').click();

  // Back in the app, signed in.
  await page.waitForURL((url) => !url.pathname.startsWith('/oidc'), { timeout: 30_000 });
  await expect(page.getByText(/signed in as/i)).toBeVisible({ timeout: 30_000 });
  return subFor(opts.email);
}

/** Create + unlock a fresh identity on the current page via the identity panel. */
export async function createIdentity(page: Page, password = 'test-password-123'): Promise<void> {
  await page.goto('/identity');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^create identity$/i }).click();
  await expect(page.getByText(/^Unlocked$/)).toBeVisible({ timeout: 15_000 });
}
