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
};

export default nextConfig;
