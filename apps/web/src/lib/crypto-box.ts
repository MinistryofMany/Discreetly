/**
 * Client-side symmetric encryption for AES rooms.
 *
 * For rooms with `encryption === 'AES'`, message content is encrypted in the
 * browser before `message.send` and decrypted on receipt. The room password
 * never leaves the browser and is never sent to the API; the API stores and
 * relays the ciphertext blind.
 *
 * Primitives mirror `identity.ts`: PBKDF2-SHA256 -> AES-GCM via WebCrypto. Each
 * message gets a fresh random IV; the salt is derived per room from a stable
 * room identifier so all members deriving from the same password reach the same
 * key, while a fresh IV per message preserves AES-GCM security.
 */

// Room keys are derived rarely (once per unlock), so we can afford a high work
// factor. The salt is the public `discreetly.room.${roomId}` - inherent to a
// shared-password room, and salts need not be secret - so the only real defense
// against an offline dictionary attack on the relayed ciphertext is a
// high-entropy room password plus a high iteration count. Room passwords MUST be
// strong: the ciphertext is offline-guessable by anyone who can read the feed.
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = 'SHA-256';
const IV_BYTES = 12;
const AES_KEY_BITS = 256;
/** Marker prefix so plaintext (pre-encryption) is never mistaken for ciphertext. */
const ENVELOPE_PREFIX = 'aesgcm.v1:';

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error('WebCrypto (crypto.subtle) is not available in this environment.');
  }
  return c.subtle;
}

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

/**
 * Derive a room AES key from a password. The salt is the room id encoded to
 * bytes so every member of a room reaches the same key from the same password,
 * with no key material exchanged over the network.
 */
export async function deriveRoomKey(password: string, roomId: string): Promise<CryptoKey> {
  if (password.length === 0) throw new Error('Room password must not be empty.');
  const s = subtle();
  const baseKey = await s.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const salt = new TextEncoder().encode(`discreetly.room.${roomId}`);
  return s.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    baseKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt `plaintext` under `key`. Returns a self-describing envelope string. */
export async function encryptContent(key: CryptoKey, plaintext: string): Promise<string> {
  const s = subtle();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await s.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as unknown as BufferSource,
  );
  return `${ENVELOPE_PREFIX}${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
}

/** True if `s` looks like an AES envelope produced by `encryptContent`. */
export function isEncryptedEnvelope(s: string): boolean {
  return s.startsWith(ENVELOPE_PREFIX);
}

export class DecryptError extends Error {}

/**
 * Decrypt an envelope produced by `encryptContent`. Throws `DecryptError` on a
 * wrong key, tampering, or a malformed envelope.
 */
export async function decryptContent(key: CryptoKey, envelope: string): Promise<string> {
  if (!isEncryptedEnvelope(envelope)) {
    throw new DecryptError('Not an AES envelope.');
  }
  const body = envelope.slice(ENVELOPE_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot === -1) throw new DecryptError('Malformed AES envelope.');
  const iv = fromBase64(body.slice(0, dot));
  const ct = fromBase64(body.slice(dot + 1));
  const s = subtle();
  let plaintext: ArrayBuffer;
  try {
    plaintext = await s.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ct as unknown as BufferSource,
    );
  } catch {
    throw new DecryptError('Wrong room password or corrupted message.');
  }
  return new TextDecoder().decode(plaintext);
}
