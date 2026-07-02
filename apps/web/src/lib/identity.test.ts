import { beforeEach, describe, expect, it } from 'vitest';
// v3 Identity is kept ONLY as a test oracle (devDependency): it is the
// belt-and-suspenders that proves the shed v3 wrapper stayed byte-compatible.
import { Identity } from '@semaphore-protocol/identity';
import { getIdentityCommitmentFromSecret } from '@ministryofmany/rln/pure';
import {
  STORAGE_KEY,
  WrongPasswordError,
  backupToBlob,
  clear,
  createIdentity,
  decryptIdentity,
  encryptIdentity,
  exportBackup,
  hasStoredIdentity,
  importBackup,
  saveEncrypted,
  unlock,
  type AppIdentity,
} from './identity';

const PW = 'correct horse battery staple';

beforeEach(() => {
  localStorage.clear();
});

describe('createIdentity', () => {
  it('produces an identity whose commitment === poseidon1(secret)', () => {
    const id = createIdentity();
    expect(id.commitment).toBe(getIdentityCommitmentFromSecret(id.secret));
  });

  it('serializes in Semaphore canonical form that restores secret + commitment', () => {
    const id = createIdentity();
    const restored = new Identity(id.serialized);
    expect(restored.secret).toBe(id.secret);
    expect(restored.commitment).toBe(id.commitment);
  });

  it('generates distinct identities', () => {
    expect(createIdentity().commitment).not.toBe(createIdentity().commitment);
  });
});

describe('v3 migration: existing localStorage envelope keeps its commitment', () => {
  it('a pre-migration [trapdoor, nullifier] envelope restores to the v3 commitment', async () => {
    // The exact bytes an old client stored: Semaphore v3 `Identity.toString()`.
    const KNOWN_BLOB = JSON.stringify(['0x123456789abcdef', '0xfedcba987654321']);
    // Oracle: what v3 itself derives for this blob (the "no member falls out of
    // the room's leaf set" guarantee - the commitment must be byte-identical).
    const v3 = new Identity(KNOWN_BLOB);

    // The encrypted store only ever held the serialized bytes; simulate that
    // pre-migration envelope, then decrypt through the NEW deserializer path.
    const preMigration = { serialized: KNOWN_BLOB, secret: 0n, commitment: 0n } as AppIdentity;
    const env = await encryptIdentity(preMigration, PW);
    const restored = await decryptIdentity(env, PW);

    expect(restored.secret).toBe(v3.secret);
    expect(restored.commitment).toBe(v3.commitment);
    expect(getIdentityCommitmentFromSecret(restored.secret)).toBe(restored.commitment);
    expect(restored.serialized).toBe(KNOWN_BLOB);
  });
});

describe('encrypt -> persist -> unlock round-trip', () => {
  it('unlocks with the correct password and recovers the same secret', async () => {
    const id = createIdentity();
    expect(hasStoredIdentity()).toBe(false);
    await saveEncrypted(id, PW);
    expect(hasStoredIdentity()).toBe(true);

    const unlocked = await unlock(PW);
    expect(unlocked.secret).toBe(id.secret);
    expect(unlocked.commitment).toBe(id.commitment);
    expect(unlocked.serialized).toBe(id.serialized);
  });

  it('never persists the plaintext secret or serialization', async () => {
    const id = createIdentity();
    await saveEncrypted(id, PW);
    const raw = localStorage.getItem(STORAGE_KEY)!;
    expect(raw).not.toContain(id.secret.toString());
    expect(raw).not.toContain(id.serialized);
    const env = JSON.parse(raw);
    expect(env.salt).toBeTypeOf('string');
    expect(env.iv).toBeTypeOf('string');
    expect(env.ciphertext).toBeTypeOf('string');
    expect(env.iterations).toBeGreaterThanOrEqual(210000);
    expect(env).not.toHaveProperty('key');
    expect(env).not.toHaveProperty('secret');
  });

  it('rejects a wrong password with WrongPasswordError', async () => {
    const id = createIdentity();
    await saveEncrypted(id, PW);
    await expect(unlock('wrong password')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('uses a fresh salt + iv per save (different ciphertext for same identity)', async () => {
    const id = createIdentity();
    await saveEncrypted(id, PW);
    const first = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    await saveEncrypted(id, PW);
    const second = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(second.salt).not.toBe(first.salt);
    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it('clear removes the stored identity', async () => {
    await saveEncrypted(createIdentity(), PW);
    expect(hasStoredIdentity()).toBe(true);
    clear();
    expect(hasStoredIdentity()).toBe(false);
  });

  it('unlock throws when there is no stored identity', async () => {
    await expect(unlock(PW)).rejects.toThrow(/No stored identity/);
  });
});

describe('export -> import backup round-trip', () => {
  it('imports a backup with the correct password', async () => {
    const id = createIdentity();
    const backup = await exportBackup(id, PW);
    expect(backup.type).toBe('discreetly-identity-backup');
    expect(backup.commitment).toBe(id.commitment.toString());

    const imported = await importBackup(JSON.stringify(backup), PW);
    expect(imported.secret).toBe(id.secret);
    expect(imported.commitment).toBe(id.commitment);
  });

  it('imports from a backup object directly', async () => {
    const id = createIdentity();
    const backup = await exportBackup(id, PW);
    const imported = await importBackup(backup, PW);
    expect(imported.commitment).toBe(id.commitment);
  });

  it('rejects an imported backup with the wrong password', async () => {
    const backup = await exportBackup(createIdentity(), PW);
    await expect(importBackup(JSON.stringify(backup), 'nope')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('rejects a file that is not a Discreetly backup', async () => {
    await expect(importBackup(JSON.stringify({ foo: 'bar' }), PW)).rejects.toThrow(
      /not a Discreetly identity backup/,
    );
  });

  it('backupToBlob produces a JSON blob', async () => {
    const backup = await exportBackup(createIdentity(), PW);
    const blob = backupToBlob(backup);
    expect(blob.type).toBe('application/json');
    const text = await blob.text();
    expect(JSON.parse(text).type).toBe('discreetly-identity-backup');
  });
});
