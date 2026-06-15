import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
      MINISTER_ISSUER: 'http://localhost:3000',
      MINISTER_JWKS_URL: 'http://localhost:3000/.well-known/jwks.json',
      MINISTER_VC_ISSUER: 'did:web:minister.local',
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
});
