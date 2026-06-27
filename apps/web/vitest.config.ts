import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// Load the repo-root .env into process.env for the DB-backed unit tests (the
// room-auth flow sweep talks to the real dev Postgres, mirroring packages/db's
// smoke test). Only vars not already set are applied, so an explicit shell env
// still wins. happy-dom tests ignore these vars.
const NEEDED = ['DATABASE_URL', 'REDIS_URL', 'RATE_LIMIT_ENABLED'] as const;
try {
  const raw = readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (!(NEEDED as readonly string[]).includes(key) || process.env[key] !== undefined) continue;
    process.env[key] = rawVal.replace(/^["']|["']$/g, '');
  }
} catch {
  // No .env (e.g. CI provides env directly); DB-backed tests read process.env.
}

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
