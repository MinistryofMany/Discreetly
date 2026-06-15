import { describe, it, expect } from 'vitest';
import { createRemoteJWKSet } from 'jose';

const DISCOVERY_URL = 'http://localhost:3000/.well-known/openid-configuration';

interface Discovery {
  issuer?: string;
  jwks_uri?: string;
  id_token_signing_alg_values_supported?: string[];
  claims_supported?: string[];
}

/**
 * Probe the LIVE Minister discovery document at module load. Only GETs; never
 * touches Minister's DB or restarts anything. If the provider is unreachable or
 * does not serve a valid discovery JSON, the suite skips gracefully.
 */
async function probeDiscovery(): Promise<Discovery | null> {
  try {
    const res = await fetch(DISCOVERY_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return null;
    return (await res.json()) as Discovery;
  } catch {
    return null;
  }
}

const discovery = await probeDiscovery();

describe.skipIf(discovery === null)('LIVE Minister discovery reachability', () => {
  it('serves a discovery document matching the expected contract', async () => {
    const d = discovery!;
    expect(d.issuer).toBe('http://localhost:3000');
    expect(d.id_token_signing_alg_values_supported).toContain('EdDSA');
    expect(d.claims_supported).toContain('minister_badges');
    expect(typeof d.jwks_uri).toBe('string');
    expect(d.jwks_uri).toBeTruthy();
  });

  it('exposes a JWKS with at least one key', async () => {
    const d = discovery!;
    const jwksUri = d.jwks_uri!;
    // Must be a constructible remote JWKS source for the production verifier.
    expect(() => createRemoteJWKSet(new URL(jwksUri))).not.toThrow();

    const res = await fetch(jwksUri);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { keys?: unknown[] };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys!.length).toBeGreaterThanOrEqual(1);
  });
});
