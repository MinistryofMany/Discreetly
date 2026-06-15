/**
 * Spawns and tears down the three e2e processes: the mock OIDC issuer, the
 * Discreetly API (pointed at the mock issuer for token verification), and the
 * web app (Auth.js pointed at the mock issuer). All run on dedicated e2e ports.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  API_PORT,
  API_URL,
  API_WS_URL,
  E2E_DATABASE_URL,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_ISSUER,
  MOCK_JWKS_URL,
  MOCK_OIDC_PORT,
  MOCK_VC_ISSUER,
  REDIS_URL,
  WEB_PORT,
  WEB_URL,
} from './env.js';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..');
const repoRoot = join(webRoot, '..', '..');
const apiRoot = join(repoRoot, 'services', 'api');

export interface RunningServers {
  stop: () => Promise<void>;
}

function tsxBin(): string {
  return join(webRoot, 'node_modules', '.bin', 'tsx');
}

async function waitForHttp(url: string, label: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.status < 500) return;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${label} at ${url}: ${String(lastErr)}`);
}

function pipe(child: ChildProcess, label: string): void {
  child.stdout?.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
}

function kill(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 5_000);
  });
}

/** Build the web app once with the e2e public API URLs inlined. */
export async function buildWeb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'next', 'build'], {
      cwd: webRoot,
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: API_URL,
        NEXT_PUBLIC_API_WS_URL: API_WS_URL,
        AUTH_URL: WEB_URL,
        AUTH_SECRET: 'e2e-auth-secret-deterministic',
        AUTH_TRUST_HOST: 'true',
        MINISTER_ISSUER: MOCK_ISSUER,
        MINISTER_CLIENT_ID: MOCK_CLIENT_ID,
        MINISTER_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
      stdio: 'inherit',
    });
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`next build exited ${code}`)),
    );
    child.once('error', reject);
  });
}

export async function startServers(): Promise<RunningServers> {
  const children: ChildProcess[] = [];

  // 1. Mock OIDC issuer.
  const mock = spawn(tsxBin(), [join(here, '..', 'mock-oidc', 'run.ts')], {
    cwd: webRoot,
    env: { ...process.env, MOCK_OIDC_PORT: String(MOCK_OIDC_PORT) },
  });
  pipe(mock, 'mock-oidc');
  children.push(mock);
  await waitForHttp(`${MOCK_ISSUER}/.well-known/openid-configuration`, 'mock-oidc');

  // 2. Discreetly API, verifier pointed at the mock issuer + JWKS.
  const api = spawn(tsxBin(), ['--tsconfig', 'tsconfig.server.json', 'src/server.ts'], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DATABASE_URL: E2E_DATABASE_URL,
      REDIS_URL,
      MINISTER_ISSUER: MOCK_ISSUER,
      MINISTER_JWKS_URL: MOCK_JWKS_URL,
      MINISTER_VC_ISSUER: MOCK_VC_ISSUER,
      MINISTER_CLIENT_ID: MOCK_CLIENT_ID,
      API_PORT: String(API_PORT),
      ALLOWED_WS_ORIGINS: `${WEB_URL},http://localhost:${WEB_PORT}`,
      // Disable transport-layer rate limiting so e2e bursts never flake.
      RATE_LIMIT_ENABLED: 'false',
    },
  });
  pipe(api, 'api');
  children.push(api);
  // The standalone tRPC server returns 404 for GET / but that means it is up.
  await waitForHttp(API_URL, 'api');

  // 3. Web app (production server with e2e env). Build must have run first.
  const web = spawn('pnpm', ['exec', 'next', 'start', '--port', String(WEB_PORT)], {
    cwd: webRoot,
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: API_URL,
      NEXT_PUBLIC_API_WS_URL: API_WS_URL,
      AUTH_URL: WEB_URL,
      AUTH_SECRET: 'e2e-auth-secret-deterministic',
      AUTH_TRUST_HOST: 'true',
      MINISTER_ISSUER: MOCK_ISSUER,
      MINISTER_CLIENT_ID: MOCK_CLIENT_ID,
      MINISTER_CLIENT_SECRET: MOCK_CLIENT_SECRET,
    },
  });
  pipe(web, 'web');
  children.push(web);
  await waitForHttp(WEB_URL, 'web');

  return {
    stop: async () => {
      for (const c of [...children].reverse()) await kill(c);
    },
  };
}
