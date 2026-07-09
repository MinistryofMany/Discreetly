import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Derive the API origins (http + ws) the browser is allowed to connect to, so
// the CSP connect-src can be locked down instead of using a wildcard.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';
const API_WS_URL = process.env.NEXT_PUBLIC_API_WS_URL ?? 'ws://localhost:3002';

/**
 * Content-Security-Policy. connect-src is restricted to self + the API. Scripts
 * need 'unsafe-inline' (Next injects an inline bootstrap) and 'unsafe-eval' /
 * 'wasm-unsafe-eval' (rlnjs compiles the RLN circuit wasm in the browser).
 * worker-src must allow data: because ffjavascript (the snark prover) spawns its
 * thread workers from a `data:application/javascript` URL. img-src allows data:
 * for the identicon data URIs.
 */
const csp = [
  `default-src 'self'`,
  `connect-src 'self' ${API_URL} ${API_WS_URL}`,
  `img-src 'self' data:`,
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:`,
  `worker-src 'self' blob: data:`,
  `style-src 'self' 'unsafe-inline'`,
  `font-src 'self' data:`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `frame-ancestors 'none'`,
]
  .join('; ')
  .concat(';');

const securityHeaders = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: csp },
];

// Monorepo root (apps/web -> ../..). Next standalone output traces the
// workspace TS-source packages from here so the self-contained server.js bundles
// every workspace dependency.
const monorepoRoot = join(__dirname, '..', '..');

// Build-time constant surfaced in the UI (a subtle "Beta · <date>" label). Fixed
// at build, so a deployed image reports the day it was built, not request time.
const BUILD_DATE = new Date().toISOString().slice(0, 10);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_BUILD_DATE: BUILD_DATE,
  },
  // Emit a self-contained server (.next/standalone) for the Docker runner image.
  output: 'standalone',
  outputFileTracingRoot: monorepoRoot,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // Workspace packages ship TS source (their `main` points at ./src/*.ts and
  // they have no build step), so Next must transpile them itself.
  transpilePackages: [
    '@ministryofmany/rln',
    '@discreetly/policy',
    '@discreetly/shared',
    '@discreetly/circuits',
    '@discreetly/api',
  ],
  webpack: (config, { isServer }) => {
    // The workspace TS sources use NodeNext-style `.js` import specifiers (e.g.
    // `export * from './field.js'`) but the files on disk are `.ts`. Map `.js`
    // requests back to their TS source so webpack can resolve them.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    // rlnjs / ffjavascript load the RLN circuit wasm; enable webpack's async
    // WebAssembly so the browser proving path bundles.
    config.experiments = { ...config.experiments, asyncWebAssembly: true };

    if (!isServer) {
      // `@discreetly/circuits` reads artifacts from disk (`node:fs`) at module
      // load for Node defaults. The browser always passes explicit Uint8Array
      // artifacts and never verifies, so alias it to a fs-free stub.
      config.resolve.alias = {
        ...config.resolve.alias,
        '@discreetly/circuits': join(__dirname, 'src/lib/circuits-browser-stub.ts'),
      };
    }
    return config;
  },
};

export default nextConfig;
