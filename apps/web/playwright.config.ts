import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright harness for apps/web. Phase 4.2 uses it for the RLN browser-proving
 * de-risk spike; Phase 4.5 extends it with full e2e coverage.
 *
 * Boots `next dev` on 3001 (reuses an already-running server locally). The spike
 * needs no API/DB: verification is in-process via `tsx`.
 */
const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  timeout: 120_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
