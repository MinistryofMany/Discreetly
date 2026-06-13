import { RLNVerifier } from 'rlnjs';
import type { RLNFullProof, VerificationKey } from 'rlnjs';
import { rlnVerificationKey } from '@discreetly/circuits';

const verifier = new RLNVerifier(rlnVerificationKey as VerificationKey);

export interface RLNVerifyParams {
  rlnIdentifier: bigint;
  proof: RLNFullProof;
  /** Expected signal hash (x) recomputed from the message by the caller. */
  signalHash: bigint;
  /** Epoch claimed by the message. */
  epoch: bigint;
  /** Server's current epoch = floor(now / rateLimit). */
  currentEpoch: bigint;
  /** Allowed epoch skew on each side. Default 1 (matches legacy). */
  epochErrorRange?: bigint;
  /** For IDENTITY_LIST rooms: the room group root the proof must match. */
  expectedRoot?: bigint;
}

/**
 * Verify an RLN proof. Reproduces the legacy four checks (epoch window, signal
 * hash match, Merkle root match, snark verification), normalizing the root to
 * BigInt before comparing.
 */
export async function verifyRLNProof(params: RLNVerifyParams): Promise<boolean> {
  const {
    rlnIdentifier,
    proof,
    signalHash,
    epoch,
    currentEpoch,
    epochErrorRange = 1n,
    expectedRoot,
  } = params;

  if (epoch < currentEpoch - epochErrorRange || epoch > currentEpoch + epochErrorRange) {
    return false;
  }
  if (signalHash !== BigInt(proof.snarkProof.publicSignals.x)) {
    return false;
  }
  if (expectedRoot !== undefined && expectedRoot !== BigInt(proof.snarkProof.publicSignals.root)) {
    return false;
  }
  return verifier.verifyProof(rlnIdentifier, proof);
}
