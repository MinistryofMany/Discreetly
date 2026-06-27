import { defineConfig } from 'vitest/config';

export default defineConfig({
  // These suites share a single Postgres database (no per-file isolation), so
  // running test files in parallel races on shared rows (e.g. two files creating
  // a Room with `String(Date.now())` as `rlnIdentifier` in the same millisecond
  // hit the unique constraint). Serialize files so the DB-backed gate is
  // deterministic.
  test: { include: ['src/**/*.test.ts'], testTimeout: 60_000, fileParallelism: false },
});
