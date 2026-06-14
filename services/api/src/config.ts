import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  MINISTER_ISSUER: z.string().url(),
  MINISTER_JWKS_URL: z.string().url(),
  MINISTER_VC_ISSUER: z.string().min(1),
  MINISTER_CLIENT_ID: z.string().min(1),
  API_PORT: z.coerce.number().default(3002),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}

export const config: Config = loadConfig();
