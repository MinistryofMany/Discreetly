import { Group } from '@semaphore-protocol/group';

/** RLN circuit Merkle tree depth (fixed by the compiled circuit). */
export const MERKLE_TREE_DEPTH = 20;

/**
 * Strips the legacy BigInt `n` suffix (and any stray non-digits) from stored
 * identity/rate-commitment strings before they enter the tree.
 */
export function sanitizeLeaves(identities: readonly (string | bigint)[]): bigint[] {
  return identities.map((i) => BigInt(String(i).replace(/\D/g, '')));
}

export function buildGroup(rlnIdentifier: bigint, leaves: readonly (string | bigint)[]): Group {
  return new Group(rlnIdentifier, MERKLE_TREE_DEPTH, sanitizeLeaves(leaves));
}

/** Build a Merkle proof for `leaf` within the room's leaf set. */
export function merkleProofForLeaf(
  rlnIdentifier: bigint,
  leaves: readonly (string | bigint)[],
  leaf: bigint,
): ReturnType<Group['generateMerkleProof']> {
  const group = buildGroup(rlnIdentifier, leaves);
  return group.generateMerkleProof(group.indexOf(leaf));
}
