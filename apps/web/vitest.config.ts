import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Mirror next.config.ts: the real circuits package reads artifacts from
      // disk with `node:fs`/`fileURLToPath` at module load, which breaks under
      // the happy-dom test environment. The browser (and these unit tests)
      // never use the on-disk defaults, so alias to the fs-free stub.
      '@discreetly/circuits': fileURLToPath(
        new URL('./src/lib/circuits-browser-stub.ts', import.meta.url),
      ),
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
