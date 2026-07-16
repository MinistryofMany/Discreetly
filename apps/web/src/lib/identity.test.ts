import { describe, expect, it } from 'vitest';
// v3 Identity is kept ONLY as a test oracle (devDependency): it is the
// belt-and-suspenders that proves the shed v3 wrapper stayed byte-compatible.
import { Identity } from '@semaphore-protocol/identity';
import { getIdentityCommitmentFromSecret } from '@ministryofmany/rln/pure';
import { deriveRoomIdentity } from './identity';

// A fixed 32-byte Ministry branch (per-app secret) for deterministic tests.
const BRANCH = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

describe('deriveRoomIdentity', () => {
  it('is deterministic and does not mutate the input branch', async () => {
    const a = await deriveRoomIdentity(BRANCH, 'room-abc');
    const b = await deriveRoomIdentity(BRANCH, 'room-abc');
    expect(a.serialized).toBe(b.serialized);
    expect(a.commitment).toBe(b.commitment);
    expect(Array.from(BRANCH)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
  });

  it('keeps the v3 chain invariants and draws valid 253-bit field elements', async () => {
    const id = await deriveRoomIdentity(BRANCH, 'room-abc');
    expect(id.commitment).toBe(getIdentityCommitmentFromSecret(id.secret));
    // Byte-compatible with the real v3 Identity oracle.
    const restored = new Identity(id.serialized);
    expect(restored.secret).toBe(id.secret);
    expect(restored.commitment).toBe(id.commitment);
    const [trapdoor, nullifier] = JSON.parse(id.serialized) as [string, string];
    expect(BigInt(trapdoor) < 1n << 253n).toBe(true);
    expect(BigInt(nullifier) < 1n << 253n).toBe(true);
  });

  // The whole point of per-room derivation: the SAME account yields a DIFFERENT
  // leaf in every room, so the public per-room leaf sets cannot be joined to
  // enumerate which rooms a member is in (the live cross-room linkage leak the
  // two old fixed derivation strings caused).
  it('derives distinct identities for distinct rooms from the same branch', async () => {
    const a = await deriveRoomIdentity(BRANCH, 'room-abc');
    const b = await deriveRoomIdentity(BRANCH, 'room-xyz');
    expect(a.commitment).not.toBe(b.commitment);
    expect(a.secret).not.toBe(b.secret);
  });

  it('derives distinct identities for distinct branches in the same room', async () => {
    const other = await deriveRoomIdentity(new Uint8Array(32).fill(0xab), 'room-abc');
    const id = await deriveRoomIdentity(BRANCH, 'room-abc');
    expect(other.commitment).not.toBe(id.commitment);
  });

  it('rejects a wrong-length branch (SDK validation, fail-loud)', async () => {
    await expect(deriveRoomIdentity(new Uint8Array(16), 'room-abc')).rejects.toThrow(/32 bytes/);
  });

  it('FREEZE: pinned derivation output - a change here forks every Ministry-linked identity', async () => {
    // Pins the whole per-room derivation (SDK HKDF construction + the
    // {kind:room, id, sub:trapdoor|nullifier} context + the 253-bit masking).
    // If this fails, the derivation changed and every Ministry-derived identity
    // would silently fork. Do NOT update the expected value to make it pass -
    // revert the derivation change instead.
    const id = await deriveRoomIdentity(BRANCH, 'room-abc');
    expect(id.serialized).toBe(FREEZE_SERIALIZED);
    expect(id.commitment.toString()).toBe(FREEZE_COMMITMENT);
  });
});

// Pinned from the frozen derivation for (BRANCH, 'room-abc'); see the FREEZE test.
const FREEZE_SERIALIZED =
  '["0x9019adc0f5e7706bf86d3b6389792a41c9ce7296d79648535e27cf618736ffa","0x192023baaebb8ed5e7948f3d609bcd14d643b7aa3ea6e4325b70060e4dae0c2f"]';
const FREEZE_COMMITMENT =
  '15016631811709996455583113144254261381459197270611095727303106506839916641265';
