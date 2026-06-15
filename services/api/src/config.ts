import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  MINISTER_ISSUER: z.string().url(),
  MINISTER_JWKS_URL: z.string().url(),
  MINISTER_VC_ISSUER: z.string().min(1),
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
