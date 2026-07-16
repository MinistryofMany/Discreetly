/**
 * Client-side Semaphore v3 identity, DERIVED per room from the Ministry branch.
 *
 * The user holds ONE root secret on their own devices (in ministry.id). Ministry
 * derives a per-app secret (the "branch") and hands it to Discreetly in the OIDC
 * callback fragment (see `minister-anon.ts`); this module turns that branch into
 * the room's Semaphore v3 identity. There is no password, no vault, and no
 * random generation: every device holding the same root derives the byte-
 * identical identity for a room, which is exactly the one-identity-per-user-per-
 * room shape RLN needs.
 *
 * PER-ROOM derivation (closes the live cross-room linkage leak): the trapdoor
 * and nullifier are two DIRECT SDK context derivations that each carry the room
 * id -`{kind:'room', id:roomId, sub:'trapdoor'}` and `{...sub:'nullifier'}`- so
 * the same user yields a DIFFERENT leaf in every room's public leaf set. (The
 * old fixed strings contained no room, so one identity produced a byte-identical
 * leaf in every room, letting anyone enumerate a member's rooms.)
 *
 * Derivation goes through `@ministryofmany/rln`'s bigint identity layer (the
 * lifted Semaphore v3 math), so no v3 `Identity` object is held:
 *   - `secret = poseidon2([nullifier, trapdoor])` is the RLN `identitySecret`.
 *   - `commitment === getIdentityCommitmentFromSecret(secret)` (poseidon1 of the
 *     secret), so collision-ban recovery maps back correctly.
 */
import {
  deserializeV3Identity,
  serializeV3Identity,
  getIdentityCommitmentFromSecret,
} from '@ministryofmany/rln/pure';

/** A loaded identity. `secret` is the RLN identitySecret; `commitment` is the IC. */
export interface AppIdentity {
  /** Canonical Semaphore v3 serialization (`[trapdoor, nullifier]` hex). */
  readonly serialized: string;
  readonly secret: bigint;
  readonly commitment: bigint;
}

export class IdentityError extends Error {}

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

/**
 * Interpret 32 derived bytes as a 253-bit field element - the top 3 bits are
 * masked off, giving a value uniform in [0, 2^253), always < the BN254 scalar
 * field order (so no modular bias). Mutates `bytes` (callers zeroize it right
 * after anyway).
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
 * Derive this room's Semaphore v3 identity from the Ministry branch (the 32-byte
 * per-app secret). The trapdoor and nullifier are two DIRECT per-context HKDF
 * derivations that carry the room id, then feed the existing v3 chain unchanged
 * (`fromSerialized` derives secret + commitment). Same (branch, roomId) -> same
 * identity on every device; different room -> different, unlinkable commitment.
 *
 * Does not mutate or retain `branch` (the caller owns and zeroizes it);
 * intermediate key buffers are zeroized here.
 */
export async function deriveRoomIdentity(
  branch: Uint8Array,
  roomId: string,
): Promise<AppIdentity> {
  // Lazy import: the SDK's derivation seam. Kept out of the boot bundle; runs
  // only when a room identity is actually needed.
  const { deriveContextKeyBytes } = await import('@ministryofmany/identity');
  const [trapdoorBytes, nullifierBytes] = await Promise.all([
    deriveContextKeyBytes(branch, { kind: 'room', id: roomId, sub: 'trapdoor' }),
    deriveContextKeyBytes(branch, { kind: 'room', id: roomId, sub: 'nullifier' }),
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
