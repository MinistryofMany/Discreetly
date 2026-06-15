import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // happy-dom provides localStorage; WebCrypto is taken from Node 20's
    // globalThis.crypto.subtle.
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    // Exclude Playwright specs (run by `playwright test`, not vitest).
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
