import { describe, it, expect } from 'vitest';
import { decodeMinisterClaims } from './minister-claims';

/**
 * Build an unsigned JWT (header.payload.signature) with the given payload.
 * decodeMinisterClaims only reads the payload segment, so the signature is
 * irrelevant - this mirrors a Minister id_token shape without needing keys.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'EdDSA', typ: 'JWT' })}.${b64(payload)}.sig`;
}

describe('decodeMinisterClaims', () => {
  it('extracts sub, name, picture, and minister_badges from a full id_token', () => {
    const token = makeJwt({
      sub: 'mock|alice@example.com',
      name: 'Alice',
      picture: 'https://example.com/a.png',
      minister_badges: ['vc.jwt.one', 'vc.jwt.two'],
    });
    expect(decodeMinisterClaims(token)).toEqual({
      sub: 'mock|alice@example.com',
      name: 'Alice',
      picture: 'https://example.com/a.png',
      ministerBadges: ['vc.jwt.one', 'vc.jwt.two'],
      anonEpoch: null,
    });
  });

  it('returns empty values for a null token', () => {
    expect(decodeMinisterClaims(null)).toEqual({
      sub: null,
      name: null,
      picture: null,
      ministerBadges: [],
      anonEpoch: null,
    });
  });

  it('falls back to empties when the token is malformed (not a JWT)', () => {
    expect(decodeMinisterClaims('not-a-jwt')).toEqual({
      sub: null,
      name: null,
      picture: null,
      ministerBadges: [],
      anonEpoch: null,
    });
  });

  it('defaults missing optional claims to null / empty array', () => {
    const token = makeJwt({ sub: 'mock|bob@example.com' });
    expect(decodeMinisterClaims(token)).toEqual({
      sub: 'mock|bob@example.com',
      name: null,
      picture: null,
      ministerBadges: [],
      anonEpoch: null,
    });
  });

  it('ignores wrong-typed claims and non-string badge entries', () => {
    const token = makeJwt({
      sub: 12345,
      name: { not: 'a string' },
      picture: false,
      minister_badges: ['good', 42, null, 'also-good'],
    });
    expect(decodeMinisterClaims(token)).toEqual({
      sub: null,
      name: null,
      picture: null,
      ministerBadges: ['good', 'also-good'],
      anonEpoch: null,
    });
  });

  it('treats a non-array minister_badges as empty', () => {
    const token = makeJwt({ sub: 'x', minister_badges: 'oops-a-string' });
    expect(decodeMinisterClaims(token).ministerBadges).toEqual([]);
  });

  it('extracts a valid minister_anon_epoch (integer >= 1)', () => {
    expect(decodeMinisterClaims(makeJwt({ sub: 'x', minister_anon_epoch: 7 })).anonEpoch).toBe(7);
  });

  it('rejects a non-integer, zero, negative, or non-number epoch (fail-closed to null)', () => {
    expect(decodeMinisterClaims(makeJwt({ sub: 'x', minister_anon_epoch: 0 })).anonEpoch).toBeNull();
    expect(
      decodeMinisterClaims(makeJwt({ sub: 'x', minister_anon_epoch: -3 })).anonEpoch,
    ).toBeNull();
    expect(
      decodeMinisterClaims(makeJwt({ sub: 'x', minister_anon_epoch: 1.5 })).anonEpoch,
    ).toBeNull();
    expect(
      decodeMinisterClaims(makeJwt({ sub: 'x', minister_anon_epoch: '2' })).anonEpoch,
    ).toBeNull();
  });
});
