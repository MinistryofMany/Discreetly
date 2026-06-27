import { poseidon2 } from 'poseidon-lite';

const FIELD = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

/** Reduce an arbitrary string (e.g. the pairwise sub) to a field element. */
export function toField(s: string): bigint {
  let acc = 0n;
  for (const byte of new TextEncoder().encode(s)) acc = (acc * 256n + BigInt(byte)) % FIELD;
  return acc;
}

/**
 * Per-room nullifier anchoring a Minister identity to a room.
 * Stable for (sub, room); unlinkable across rooms. ZK-friendly (Poseidon).
 */
export function joinNullifier(sub: string, rlnIdentifier: bigint): bigint {
  return poseidon2([toField(sub), rlnIdentifier % FIELD]);
}
