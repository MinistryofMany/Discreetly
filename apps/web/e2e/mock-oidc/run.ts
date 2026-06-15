/**
 * Standalone entry to run the mock OIDC issuer as its own process so the web RP
 * (Auth.js) and the Discreetly API both fetch the same JWKS over HTTP from one
 * stable EdDSA key. Port comes from MOCK_OIDC_PORT (default 3399).
 */
import { startMockIssuer } from './issuer.js';

const port = Number(process.env.MOCK_OIDC_PORT ?? 3399);
const handle = await startMockIssuer(port);
// eslint-disable-next-line no-console
console.log(`[mock-oidc] listening on ${handle.url}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void handle.close().then(() => process.exit(0));
  });
}
