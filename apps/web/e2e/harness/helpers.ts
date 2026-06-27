/**
 * Spec-side helpers: drive the mock OIDC sign-in through Auth.js, read/seed DB
 * truth, and mint unique slugs/subs so specs are independent.
 */
import { expect, type Page } from '@playwright/test';
import { getPrisma, seedAdmin, resetData } from './db.js';
import { subFor } from '../mock-oidc/issuer.js';
import { MOCK_ISSUER } from './env.js';

export { getPrisma, seedAdmin, resetData, subFor };

export interface AuthorizeLogEntry {
  state: string;
  scope: string;
  scopes: string[];
  /** The raw `minister_policy` param the RP sent, or null (Phase 2). */
  ministerPolicy: string | null;
}

/** All /oidc/authorize requests the mock issuer saw, newest last. */
export async function getAuthorizeLog(): Promise<AuthorizeLogEntry[]> {
  const res = await fetch(`${MOCK_ISSUER}/test/authorize-log`);
  const body = (await res.json()) as { entries: AuthorizeLogEntry[] };
  return body.entries;
}

/** The space-delimited scope of the most recent /oidc/authorize request. */
export async function lastAuthorizeScope(): Promise<string> {
  const log = await getAuthorizeLog();
  if (log.length === 0) throw new Error('no authorize requests recorded yet');
  return log[log.length - 1]!.scope;
}

/** The badge:* scopes of the most recent authorize, sorted (no openid/profile). */
export async function lastAuthorizeBadgeScopes(): Promise<string[]> {
  const scope = await lastAuthorizeScope();
  return scope
    .split(/\s+/)
    .filter((s) => s.startsWith('badge:'))
    .sort();
}

/** Whether the most recent /oidc/authorize carried a `minister_policy` param (Phase 2). */
export async function lastAuthorizeHasMinisterPolicy(): Promise<boolean> {
  const log = await getAuthorizeLog();
  if (log.length === 0) throw new Error('no authorize requests recorded yet');
  return log[log.length - 1]!.ministerPolicy !== null;
}

/**
 * The simulated Minister per-(user, client) grant for `sub`: the monotone union
 * of badge TYPES disclosed to this RP so far, sorted (Path B's IdP-side "already
 * proven to this platform" record). The RP keeps NO durable badge store, so this
 * is read from the mock issuer, not the Discreetly database.
 */
export async function grantedTypesFor(sub: string): Promise<string[]> {
  const res = await fetch(`${MOCK_ISSUER}/test/grant?sub=${encodeURIComponent(sub)}`);
  const body = (await res.json()) as { badgeTypes: string[] };
  return body.badgeTypes;
}

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

  // Back in the app, signed in. The header swaps to a "Sign out" control once
  // authenticated; assert on that rather than landing copy (which intentionally
  // discloses no identifier).
  await page.waitForURL((url) => !url.pathname.startsWith('/oidc'), { timeout: 30_000 });
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible({ timeout: 30_000 });
  return subFor(opts.email);
}

/** Create + unlock a fresh identity on the current page via the identity panel. */
export async function createIdentity(page: Page, password = 'test-password-123'): Promise<void> {
  await page.goto('/identity');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^create identity$/i }).click();
  await expect(page.getByText(/^Unlocked$/)).toBeVisible({ timeout: 15_000 });
}
