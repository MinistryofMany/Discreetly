import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
      MINISTER_ISSUER: 'http://localhost:3000',
      MINISTER_CLIENT_ID: 'discreetly_dev',
    } as NodeJS.ProcessEnv);
    expect(c.API_PORT).toBe(3002);
    expect(c.MINISTER_CLIENT_ID).toBe('discreetly_dev');
  });
  it('rejects a missing issuer', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://u:p@h:5432/d' } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('rejects a path-bearing issuer at boot (SDK DID derivation would fail)', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
        MINISTER_ISSUER: 'http://localhost:3000/oidc',
        MINISTER_CLIENT_ID: 'discreetly_dev',
      } as NodeJS.ProcessEnv),
    ).toThrow(/VC issuer DID/);
  });

  it('accepts MINISTER_VC_ISSUER equal to the derived DID (port percent-encoded)', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
      MINISTER_ISSUER: 'http://localhost:3000',
      MINISTER_VC_ISSUER: 'did:web:localhost%3A3000',
      MINISTER_CLIENT_ID: 'discreetly_dev',
    } as NodeJS.ProcessEnv);
    expect(c.MINISTER_VC_ISSUER).toBe('did:web:localhost%3A3000');
  });

  it('fails loud at boot when MINISTER_VC_ISSUER does not match the derived DID', () => {
    // The confirmed foot-gun: issuer host (host.docker.internal) differs from
    // the domain Minister stamps into its VCs. Without this check every badge
    // is silently rejected at runtime.
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
        MINISTER_ISSUER: 'http://host.docker.internal:3000',
        MINISTER_VC_ISSUER: 'did:web:ministry.id',
        MINISTER_CLIENT_ID: 'discreetly_dev',
      } as NodeJS.ProcessEnv),
    ).toThrow(/VC-issuer mismatch/);
  });

  it('rejects a MINISTER_VC_ISSUER that is not a did:web DID', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
        MINISTER_ISSUER: 'http://localhost:3000',
        MINISTER_VC_ISSUER: 'https://ministry.id',
        MINISTER_CLIENT_ID: 'discreetly_dev',
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
