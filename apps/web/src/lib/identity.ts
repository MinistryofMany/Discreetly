/**
 * Client-side Semaphore identity management.
 *
 * The identity secret is generated and stored entirely in the browser. It is
 * encrypted at rest with a user password (PBKDF2-SHA256 -> AES-GCM via
 * WebCrypto) and persisted to localStorage. The derived key and the plaintext
 * secret are NEVER persisted and NEVER sent over the network.
 *
 * Derivation goes through `@ministryofmany/rln`'s bigint identity layer (the
 * lifted Semaphore v3 math), so no v3 `Identity` object is held:
 *   - `secret = poseidon2([nullifier, trapdoor])` is the RLN `identitySecret`.
 *   - `commitment === getIdentityCommitmentFromSecret(secret)` (poseidon1 of the
 *     secret), so collision-ban recovery maps back correctly.
 *
 * Serialization is the canonical Semaphore v3 form (`[trapdoor, nullifier]` hex),
 * reproduced byte-for-byte by `serializeV3Identity` / parsed by
 * `deserializeV3Identity`, so existing localStorage/backup blobs round-trip to
 * the SAME commitment with no re-enrollment.
 */
import {
  deserializeV3Identity,
  serializeV3Identity,
  randomBigInt,
  getIdentityCommitmentFromSecret,
} from '@ministryofmany/rln/pure';

export const STORAGE_KEY = 'discreetly.identity.v1';

/** PBKDF2 iteration count. Spec floor is 210000. */
export const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_HASH = 'SHA-256';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AES_KEY_BITS = 256;

/** A loaded identity. `secret` is the RLN identitySecret; `commitment` is the IC. */
export interface AppIdentity {
  /** Canonical Semaphore v3 serialization (`[trapdoor, nullifier]` hex). */
  readonly serialized: string;
  readonly secret: bigint;
  readonly commitment: bigint;
}

/** Encrypted-at-rest envelope persisted in localStorage / exported as backup. */
export interface EncryptedIdentity {
  readonly v: 1;
  readonly kdf: 'PBKDF2';
  readonly hash: 'SHA-256';
  readonly iterations: number;
  /** base64 */
  readonly salt: string;
  /** base64 */
  readonly iv: string;
  /** base64 (AES-GCM ciphertext including the auth tag) */
  readonly ciphertext: string;
}

export class IdentityError extends Error {}
export class WrongPasswordError extends IdentityError {
  constructor() {
    super('Incorrect password or corrupted identity data.');
    this.name = 'WrongPasswordError';
  }
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new IdentityError('WebCrypto (crypto.subtle) is not available in this environment.');
  }
  return c.subtle;
}

function getStorage(): Storage {
  if (typeof localStorage === 'undefined') {
    throw new IdentityError('localStorage is not available in this environment.');
  }
  return localStorage;
}

// --- base64 helpers (browser-safe, no Buffer dependency) ---

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function fromSerialized(serialized: string): AppIdentity {
  const { secret, commitment } = deserializeV3Identity(serialized);
  // Invariant: the IC the server stores must equal poseidon1(secret) so shamir
  // collision recovery (getIdentityCommitmentFromSecret) maps back. The
  // deserializer sets commitment = poseidon1(secret), so this is a structural
  // guarantee - kept as a cheap tripwire.
  if (getIdentityCommitmentFromSecret(secret) !== commitment) {
    throw new IdentityError('Identity invariant violated: commitment != poseidon1(secret).');
  }
  return { serialized, secret, commitment };
}

// --- public API ---

/** Generate a brand-new Semaphore v3 identity (client-side, never persisted plaintext). */
export function createIdentity(): AppIdentity {
  // Draw two field elements (trapdoor, nullifier) and serialize them in the
  // canonical v3 form; `fromSerialized` derives secret = poseidon2([nullifier,
  // trapdoor]) and commitment = poseidon1(secret). Byte-compatible with any
  // identity a prior v3 `new Identity()` would have produced for the same pair.
  const trapdoor = randomBigInt();
  const nullifier = randomBigInt();
  return fromSerialized(serializeV3Identity(trapdoor, nullifier));
}

/**
 * HKDF context strings for the Ministry-derived identity (anon-identity master
 * spec 9.3). VERSIONED AND FROZEN: changing either string (or the SDK's
 * derivation they feed) silently re-derives a different identity for every
 * Ministry-linked user. The freeze test in identity.test.ts pins the output.
 */
const MINISTER_TRAPDOOR_CONTEXT = 'discreetly/identity/v3/trapdoor/v1';
const MINISTER_NULLIFIER_CONTEXT = 'discreetly/identity/v3/nullifier/v1';

/**
 * Interpret 32 derived bytes as a 253-bit field element - the top 3 bits are
 * masked off, giving exactly the distribution `randomBigInt(253)` draws for
 * the random-identity path (uniform in [0, 2^253), always < the BN254 scalar
 * field order). Mutates `bytes` (callers zeroize it right after anyway).
 */
function to253BitField(bytes: Uint8Array): bigint {
  bytes[0] = bytes[0]! & 0x1f;
  let hex = '0x';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return BigInt(hex);
}

/**
 * Deterministically derive the Semaphore v3 identity from a Ministry-derived
 * 32-byte device seed (see `minister-anon.ts`): the seed expands into the
 * (trapdoor, nullifier) pair via the SDK's HKDF seam with Discreetly-versioned
 * context strings, then feeds the EXISTING chain unchanged (`fromSerialized`
 * derives secret + commitment exactly as `createIdentity` does).
 *
 * Same seed -> same identity, which is what makes a Ministry-linked identity
 * recoverable on a new device. Does not mutate or retain `deviceSeed` (the
 * caller owns and zeroizes it); intermediate key buffers are zeroized here.
 */
export async function deriveIdentityFromDeviceSeed(deviceSeed: Uint8Array): Promise<AppIdentity> {
  // Lazy import: the SDK (Semaphore v4 dependency tree) stays out of the boot
  // bundle; this path only runs on an explicit identity create.
  const { derivePrivateKeyBytes } = await import('@ministryofmany/identity');
  const [trapdoorBytes, nullifierBytes] = await Promise.all([
    derivePrivateKeyBytes(deviceSeed, MINISTER_TRAPDOOR_CONTEXT),
    derivePrivateKeyBytes(deviceSeed, MINISTER_NULLIFIER_CONTEXT),
  ]);
  try {
    const trapdoor = to253BitField(trapdoorBytes);
    const nullifier = to253BitField(nullifierBytes);
    return fromSerialized(serializeV3Identity(trapdoor, nullifier));
  } finally {
    trapdoorBytes.fill(0);
    nullifierBytes.fill(0);
  }
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const s = subtle();
  const baseKey = await s.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return s.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: PBKDF2_HASH },
    baseKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt an identity's serialization under `password`. Returns the envelope. */
export async function encryptIdentity(
  identity: AppIdentity,
  password: string,
): Promise<EncryptedIdentity> {
  if (password.length === 0) throw new IdentityError('Password must not be empty.');
  const s = subtle();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(identity.serialized);
  const ct = await s.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    plaintext as unknown as BufferSource,
  );
  return {
    v: 1,
    kdf: 'PBKDF2',
    hash: PBKDF2_HASH,
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ct)),
  };
}

/** Decrypt an envelope. Throws `WrongPasswordError` on a bad password / tamper. */
export async function decryptIdentity(
  env: EncryptedIdentity,
  password: string,
): Promise<AppIdentity> {
  if (env.v !== 1) throw new IdentityError(`Unsupported identity envelope version: ${env.v}`);
  const s = subtle();
  const salt = fromBase64(env.salt);
  const iv = fromBase64(env.iv);
  const ciphertext = fromBase64(env.ciphertext);
  const key = await deriveKey(password, salt, env.iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await s.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource,
    );
  } catch {
    // AES-GCM auth-tag failure -> wrong password or corrupted data.
    throw new WrongPasswordError();
  }
  const serialized = new TextDecoder().decode(plaintext);
  return fromSerialized(serialized);
}

/** Encrypt `identity` and persist it to localStorage under the versioned key. */
export async function saveEncrypted(identity: AppIdentity, password: string): Promise<void> {
  const env = await encryptIdentity(identity, password);
  getStorage().setItem(STORAGE_KEY, JSON.stringify(env));
}

/** True if an encrypted identity is present in localStorage. */
export function hasStoredIdentity(): boolean {
  try {
    return getStorage().getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function loadEnvelope(): EncryptedIdentity | null {
  const raw = getStorage().getItem(STORAGE_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IdentityError('Stored identity is not valid JSON.');
  }
  return parsed as EncryptedIdentity;
}

/** Decrypt and return the stored identity, or throw if none / wrong password. */
export async function unlock(password: string): Promise<AppIdentity> {
  const env = loadEnvelope();
  if (env === null) throw new IdentityError('No stored identity to unlock.');
  return decryptIdentity(env, password);
}

/** Remove the stored identity from localStorage. */
export function clear(): void {
  getStorage().removeItem(STORAGE_KEY);
}

const BACKUP_TYPE = 'discreetly-identity-backup';

/** Password-encrypted backup: the encrypted envelope plus the public commitment. */
export interface EncryptedIdentityBackup extends EncryptedIdentity {
  readonly type: typeof BACKUP_TYPE;
  /** Explicit for new backups; absent on legacy encrypted backups (treated as encrypted). */
  readonly encrypted?: true;
  /** Public commitment, for operator reference. Decimal string. */
  readonly commitment: string;
}

/**
 * Unencrypted backup: the canonical identity serialization in the clear. Anyone
 * with this file can impersonate the holder, so it is only produced behind an
 * explicit confirmation.
 */
export interface PlaintextIdentityBackup {
  readonly type: typeof BACKUP_TYPE;
  readonly encrypted: false;
  /** Public commitment, for operator reference. Decimal string. */
  readonly commitment: string;
  /** Canonical Semaphore v3 serialization (`[trapdoor, nullifier]` hex), in the clear. */
  readonly serialized: string;
}

export type IdentityBackup = EncryptedIdentityBackup | PlaintextIdentityBackup;

/** True if a parsed backup is the unencrypted (plaintext) variant. */
function isPlaintextBackup(backup: IdentityBackup): backup is PlaintextIdentityBackup {
  return (backup as PlaintextIdentityBackup).encrypted === false;
}

/** Produce a downloadable, password-encrypted backup of `identity`. */
export async function exportBackup(
  identity: AppIdentity,
  password: string,
): Promise<EncryptedIdentityBackup> {
  const env = await encryptIdentity(identity, password);
  return {
    ...env,
    type: BACKUP_TYPE,
    encrypted: true,
    commitment: identity.commitment.toString(),
  };
}

/**
 * Produce a downloadable UNENCRYPTED backup of `identity`. The secret is written
 * in the clear; callers MUST gate this behind an explicit user confirmation.
 */
export function exportPlaintextBackup(identity: AppIdentity): PlaintextIdentityBackup {
  return {
    type: BACKUP_TYPE,
    encrypted: false,
    commitment: identity.commitment.toString(),
    serialized: identity.serialized,
  };
}

/** Serialize a backup to a JSON Blob for download. */
export function backupToBlob(backup: IdentityBackup): Blob {
  return new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
}

/**
 * Decrypt/parse a backup (JSON string or object). An unencrypted backup ignores
 * `password`; an encrypted one requires it. Does not persist.
 */
export async function importBackup(
  json: string | IdentityBackup,
  password = '',
): Promise<AppIdentity> {
  let backup: IdentityBackup;
  if (typeof json === 'string') {
    try {
      backup = JSON.parse(json) as IdentityBackup;
    } catch {
      throw new IdentityError('Backup is not valid JSON.');
    }
  } else {
    backup = json;
  }
  if (backup.type !== BACKUP_TYPE) {
    throw new IdentityError('File is not a Discreetly identity backup.');
  }
  if (isPlaintextBackup(backup)) {
    if (typeof backup.serialized !== 'string' || backup.serialized.length === 0) {
      throw new IdentityError('Unencrypted backup is missing its identity data.');
    }
    return fromSerialized(backup.serialized);
  }
  return decryptIdentity(backup, password);
}

/** True if a parsed/JSON backup is the unencrypted variant (needs no password). */
export function backupIsPlaintext(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as Partial<PlaintextIdentityBackup>;
    return parsed.type === BACKUP_TYPE && parsed.encrypted === false;
  } catch {
    return false;
  }
}
