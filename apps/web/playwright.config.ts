import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Playwright harness for apps/web e2e (Phase 4.5).
 *
 * `globalSetup` prepares an isolated `discreetly_e2e` database, builds the web
 * app with e2e env, and boots the mock OIDC issuer (3399), the API (3398), and
 * the web app (3397). `globalTeardown` stops them. Specs talk to the web app on
 * 3397 and assert DB truth via the e2e Prisma client.
 *
 * The RLN browser-proving spike (rln-spike.spec.ts) runs against the same web
 * server (it only needs the page; verification is in-process via tsx).
 */
const here = dirname(fileURLToPath(import.meta.url));
const WEB_PORT = 3397;
const BASE_URL = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  globalSetup: join(here, 'e2e/harness/global-setup.ts'),
  globalTeardown: join(here, 'e2e/harness/global-teardown.ts'),
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
