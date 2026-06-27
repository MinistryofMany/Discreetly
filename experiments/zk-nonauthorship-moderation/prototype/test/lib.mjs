// EXPLORATORY PROTOTYPE - NOT wired into Discreetly.
// Shared helpers matching Discreetly conventions:
//   - Poseidon via poseidon-lite (same as packages/crypto)
//   - Merkle tree via @semaphore-protocol/group v3.10.1 (same as packages/crypto/rln/merkle.ts)
//   - BN254 scalar field, depth-20 tree.

import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite';
import { Group } from '@semaphore-protocol/group';
import { keccak256 } from '@ethersproject/keccak256';
import { toUtf8Bytes } from '@ethersproject/strings';

export const BN254_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const MERKLE_TREE_DEPTH = 20;

// TAG_DOMAIN = keccak256("discreetly/nonauth/v1") >> 8, reduced mod p.
// (DESIGN.md sec 10: a fixed circuit constant.)
export const TAG_DOMAIN =
  (BigInt(keccak256(toUtf8Bytes('discreetly/nonauth/v1'))) >> 8n) % BN254_P;

// --- crypto primitives (match packages/crypto) ---

// idc = Poseidon(s)
export const identityCommitment = (s) => poseidon1([s]);

// rc = Poseidon(idc, uml)  (getRateCommitmentHash)
export const rateCommitment = (idc, uml) => poseidon2([idc, BigInt(uml)]);

export const leafFromSecret = (s, uml) => rateCommitment(identityCommitment(s), uml);

// T_M / myTag = Poseidon(TAG_DOMAIN, s, idM)
export const tagFromSecret = (s, idM) => poseidon3([TAG_DOMAIN, s, idM]);

// cn = Poseidon(s, challengeId)
export const challengeNullifier = (s, challengeId) => poseidon2([s, challengeId]);

// e_i = Poseidon(idM_i, T_Mi)  (batched, DESIGN.md sec 6.3 / 10.5)
export const batchEntry = (idM, authorTag) => poseidon2([idM, authorTag]);
// d_i(s) = Poseidon(idM_i, Poseidon(TAG_DOMAIN, s, idM_i))
export const derivedTag = (s, idM) => poseidon2([idM, tagFromSecret(s, idM)]);

// modular inverse over BN254 (for the non-equality witness)
export function modInv(a) {
  let m = BN254_P;
  let x = ((a % m) + m) % m;
  let [old_r, r] = [x, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error('not invertible (value is 0 mod p)');
  return ((old_s % m) + m) % m;
}

// fieldSub mod p
export const sub = (a, b) => ((((a - b) % BN254_P) + BN254_P) % BN254_P);

// --- Merkle tree (Semaphore group v3, same convention as crypto/rln/merkle.ts) ---
export function buildGroup(rlnIdentifier, leaves) {
  return new Group(rlnIdentifier, MERKLE_TREE_DEPTH, leaves.map((l) => BigInt(l)));
}

// Returns { root, pathElements, pathIndices } for `leaf`, in circuit order.
export function merkleWitness(rlnIdentifier, leaves, leaf) {
  const group = buildGroup(rlnIdentifier, leaves);
  const idx = group.indexOf(BigInt(leaf));
  if (idx < 0) throw new Error('leaf not in group');
  const proof = group.generateMerkleProof(idx);
  return {
    root: BigInt(proof.root),
    pathElements: proof.siblings.map((s) => BigInt(Array.isArray(s) ? s[0] : s)),
    pathIndices: proof.pathIndices.map((b) => BigInt(b)),
  };
}
