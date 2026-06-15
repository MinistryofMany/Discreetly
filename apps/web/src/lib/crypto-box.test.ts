import { describe, expect, it } from 'vitest';
import {
  DecryptError,
  decryptContent,
  deriveRoomKey,
  encryptContent,
  isEncryptedEnvelope,
} from './crypto-box';

const ROOM = 'room_abc123';
const PW = 'hunter2 hunter2';

describe('AES room encryption round-trip', () => {
  it('encrypts then decrypts back to the original plaintext', async () => {
    const key = await deriveRoomKey(PW, ROOM);
    const env = await encryptContent(key, 'hello world');
    expect(isEncryptedEnvelope(env)).toBe(true);
    expect(env).not.toContain('hello world');
    const out = await decryptContent(key, env);
    expect(out).toBe('hello world');
  });

  it('preserves unicode content', async () => {
    const key = await deriveRoomKey(PW, ROOM);
    const msg = 'gm \u{1F510} éàü 中文';
    const env = await encryptContent(key, msg);
    expect(await decryptContent(key, env)).toBe(msg);
  });

  it('uses a fresh IV per message (distinct ciphertext for same plaintext)', async () => {
    const key = await deriveRoomKey(PW, ROOM);
    const a = await encryptContent(key, 'same');
    const b = await encryptContent(key, 'same');
    expect(a).not.toBe(b);
    expect(await decryptContent(key, a)).toBe('same');
    expect(await decryptContent(key, b)).toBe('same');
  });

  it('derives the same key from the same password+room (cross-member)', async () => {
    const k1 = await deriveRoomKey(PW, ROOM);
    const k2 = await deriveRoomKey(PW, ROOM);
    const env = await encryptContent(k1, 'shared');
    expect(await decryptContent(k2, env)).toBe('shared');
  });

  it('a different room id yields a non-interoperable key', async () => {
    const k1 = await deriveRoomKey(PW, ROOM);
    const k2 = await deriveRoomKey(PW, 'room_other');
    const env = await encryptContent(k1, 'secret');
    await expect(decryptContent(k2, env)).rejects.toBeInstanceOf(DecryptError);
  });

  it('a wrong password fails to decrypt', async () => {
    const k1 = await deriveRoomKey(PW, ROOM);
    const k2 = await deriveRoomKey('wrong password', ROOM);
    const env = await encryptContent(k1, 'secret');
    await expect(decryptContent(k2, env)).rejects.toBeInstanceOf(DecryptError);
  });

  it('rejects a non-envelope string', async () => {
    const key = await deriveRoomKey(PW, ROOM);
    await expect(decryptContent(key, 'plain text')).rejects.toBeInstanceOf(DecryptError);
    expect(isEncryptedEnvelope('plain text')).toBe(false);
  });

  it('rejects an empty password on derivation', async () => {
    await expect(deriveRoomKey('', ROOM)).rejects.toThrow(/must not be empty/);
  });
});
