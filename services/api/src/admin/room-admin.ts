import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { genId, randomBigInt } from '@discreetly/crypto';

const scryptAsync = promisify(scrypt);

const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

/** Generate a Poseidon-based RLN room identifier from a server-random bigint + the room name. */
export function generateRlnIdentifier(name: string): string {
  return genId(randomBigInt(), name).toString();
}

/**
 * Hash a room password with scrypt. Format: `scrypt$<saltHex>$<hashHex>`.
 * No new dependency — uses Node built-in `crypto`.
 */
export async function hashRoomPassword(pw: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = (await scryptAsync(pw, salt, SCRYPT_KEYLEN)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Verify a room password against a stored `scrypt$<saltHex>$<hashHex>` string.
 * Uses `timingSafeEqual` to prevent timing attacks.
 */
export async function verifyRoomPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  const actual = (await scryptAsync(pw, salt, SCRYPT_KEYLEN)) as Buffer;
  return timingSafeEqual(actual, expected);
}
