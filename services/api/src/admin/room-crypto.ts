import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { genId, randomBigInt } from '@ministryofmany/rln';
import type { Prisma } from '@discreetly/db';
import { policyNodeSchema, type PolicyNode } from '@discreetly/policy';
import { z } from 'zod';

/** Promisified scrypt with explicit cost options (promisify's typing omits the options overload). */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

/** Default scrypt cost parameters. Encoded per-record so cost is upgradable. */
const SCRYPT_N = 1 << 17; // 131072
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// maxmem must exceed 128 * N * r (~134MB at N=2^17, r=8). Give headroom.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** Generate a Poseidon-based RLN room identifier from a server-random bigint + the room name. */
export function generateRlnIdentifier(name: string): string {
  return genId(randomBigInt(), name).toString();
}

/**
 * Hash a room password with scrypt.
 * Format: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` (cost params encoded per-record).
 * No new dependency — uses Node built-in `crypto`.
 */
export async function hashRoomPassword(pw: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(pw, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Verify a room password against a stored
 * `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` string. Cost params are read back from
 * the record so older/cheaper hashes still verify. Uses `timingSafeEqual`.
 *
 * Backs the AES-room read/join path in Plan 4 (password-gated room access).
 */
export async function verifyRoomPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  // scrypt $ N $ r $ p $ salt $ hash  => 6 parts
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N <= 0 || r <= 0 || p <= 0) return false;

  const salt = Buffer.from(parts[4]!, 'hex');
  const expected = Buffer.from(parts[5]!, 'hex');
  const actual = await scryptAsync(pw, salt, SCRYPT_KEYLEN, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });

  // timingSafeEqual throws RangeError on length mismatch; guard first. A stored
  // digest of an unexpected length (corrupt/tampered) thus fails closed.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Single documented home for the Prisma JSON cast of a validated policy. A
 * `PolicyNode` is plain JSON-serialisable data, but its recursive type does not
 * structurally match `Prisma.InputJsonValue`, so one narrow cast lives here.
 */
export function policyToJson(p: PolicyNode): Prisma.InputJsonValue {
  return p as unknown as Prisma.InputJsonValue;
}

/** Validate untrusted accessPolicy input, mapping ZodError to a TRPC BAD_REQUEST. */
export function validatePolicyInput(input: unknown): PolicyNode {
  try {
    return policyNodeSchema.parse(input);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid accessPolicy' });
    }
    throw err;
  }
}
