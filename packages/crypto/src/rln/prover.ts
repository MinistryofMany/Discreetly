import { RLNProver } from 'rlnjs';
import type { RLNFullProof } from 'rlnjs';
import type { Group } from '@semaphore-protocol/group';
import { rlnWasmPath, rlnZkeyPath } from '@discreetly/circuits';

export interface RLNProofInputs {
  rlnIdentifier: bigint;
  identitySecret: bigint;
  userMessageLimit: bigint;
  messageId: bigint;
  merkleProof: ReturnType<Group['generateMerkleProof']>;
  /** signal hash (x) from calculateSignalHash. */
  x: bigint;
  epoch: bigint;
}

/**
 * Generate an RLN proof. Artifacts default to the vendored Node paths; pass
 * Uint8Array sources in the browser build (Plan 4).
 */
export async function generateRLNProof(
  inputs: RLNProofInputs,
  artifacts: { wasm: string | Uint8Array; zkey: string | Uint8Array } = {
    wasm: rlnWasmPath,
    zkey: rlnZkeyPath,
  },
): Promise<RLNFullProof> {
  const prover = new RLNProver(artifacts.wasm, artifacts.zkey);
  return prover.generateProof(inputs);
}
