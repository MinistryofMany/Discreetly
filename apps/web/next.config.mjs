import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TS source (their `main` points at ./src/*.ts and
  // they have no build step), so Next must transpile them itself.
  transpilePackages: [
    '@discreetly/crypto',
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
