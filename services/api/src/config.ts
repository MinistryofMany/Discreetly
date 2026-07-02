import { z } from 'zod';
import dotenv from 'dotenv';
import { didFromIssuer } from '@ministryofmany/client';
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
  /**
   * Optional cross-check for the SDK's VC-issuer coupling. The SDK derives the
   * badge VC issuer DID from MINISTER_ISSUER's host with no override, so it
   * must equal the DID Minister actually stamps (did:web:<Minister's
   * MINISTER_ISSUER_DOMAIN>). Set this to that DID and boot fails loud on a
   * mismatch instead of silently rejecting every badge at runtime.
   */
  MINISTER_VC_ISSUER: z.string().startsWith('did:web:').optional(),
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
  const config = schema.parse(env);

  // Fail fast on the VC-issuer/host coupling. `@ministryofmany/client` derives
  // the expected badge VC issuer DID (`did:web:<host>`) from MINISTER_ISSUER's
  // host, with no override. If that host does not match the domain Minister
  // stamps its VCs with (Minister's MINISTER_ISSUER_DOMAIN), every disclosed
  // badge is silently rejected at runtime: login still works, but no badge
  // ever counts and every gated join is denied. Surface both failure modes at
  // boot instead:
  //
  // 1. A structurally unusable issuer (e.g. carrying a path) makes the SDK's
  //    DID derivation throw on the first verification - re-run the same
  //    derivation here so a bad MINISTER_ISSUER kills startup with a clear
  //    message.
  let derivedVcIssuer: string;
  try {
    derivedVcIssuer = didFromIssuer(config.MINISTER_ISSUER);
  } catch (cause) {
    throw new Error(
      `MINISTER_ISSUER ("${config.MINISTER_ISSUER}") cannot be used to derive Minister's ` +
        `VC issuer DID: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `It must be Minister's bare origin (scheme + host[:port], no path/query/fragment).`,
      { cause },
    );
  }
  // 2. When the deployment states the DID Minister actually signs with
  //    (MINISTER_VC_ISSUER, copied from Minister's MINISTER_ISSUER_DOMAIN),
  //    assert the SDK's derivation matches it. This catches the confirmed
  //    foot-gun where MINISTER_ISSUER's host (e.g. host.docker.internal:3000)
  //    is not the domain Minister stamps into its VCs.
  if (config.MINISTER_VC_ISSUER !== undefined && config.MINISTER_VC_ISSUER !== derivedVcIssuer) {
    throw new Error(
      `Minister VC-issuer mismatch: the SDK derives "${derivedVcIssuer}" from ` +
        `MINISTER_ISSUER ("${config.MINISTER_ISSUER}"), but MINISTER_VC_ISSUER is ` +
        `"${config.MINISTER_VC_ISSUER}". Badges are verified against the DERIVED DID, so ` +
        `with this configuration every badge would be rejected at runtime (login works, ` +
        `no badge ever counts). Point MINISTER_ISSUER at an origin whose host equals ` +
        `Minister's MINISTER_ISSUER_DOMAIN, or fix MINISTER_VC_ISSUER if it is stale.`,
    );
  }

  return config;
}

let cached: Config | undefined;
export function getConfig(): Config {
  return (cached ??= loadConfig());
}
