import { z } from 'zod';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load the repo-root .env so the API is self-sufficient no matter how it is
// launched. Turborepo 2.x defaults to strict env-mode and does not pass the
// shell environment into tasks, so `pnpm dev` would otherwise start the API
// with no config. Values already present in process.env take precedence —
// dotenv never overrides an existing variable.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  MINISTER_ISSUER: z.string().url(),
  MINISTER_CLIENT_ID: z.string().min(1),
  API_PORT: z.coerce.number().default(3002),

  // Transport-layer (per-IP) abuse rate limiting. Disabled in tests/e2e to
  // avoid flakes. Coercion: env vars arrive as strings.
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_MUTATION_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WS_MAX_PER_IP: z.coerce.number().int().positive().default(20),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}

let cached: Config | undefined;
export function getConfig(): Config {
  return (cached ??= loadConfig());
}
