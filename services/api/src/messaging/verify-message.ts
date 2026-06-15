import type { RLNFullProof } from 'rlnjs';
import { calculateSignalHash } from '@discreetly/crypto';
import { verifyRLNProof, computeRoot } from '@discreetly/crypto/rln';

export interface VerifyMessageInput {
  rlnIdentifier: bigint;
  proof: RLNFullProof;
  content: string;
  leaves: readonly (string | bigint)[];
  currentEpoch: bigint;
  epochErrorRange?: bigint;
}

export type VerifyMessageResult =
  | { ok: true; epoch: bigint; nullifier: string; x: string; y: string }
  | { ok: false; reason: 'bad-epoch' | 'bad-signal' | 'bad-proof' };

/** Verify an incoming message's RLN proof. Epoch is the proof-bound value, not client-supplied. */
export async function verifyMessage(input: VerifyMessageInput): Promise<VerifyMessageResult> {
  const epoch = BigInt(input.proof.epoch);
  const range = input.epochErrorRange ?? 1n;
  if (epoch < input.currentEpoch - range || epoch > input.currentEpoch + range) {
    return { ok: false, reason: 'bad-epoch' };
  }
  const signalHash = calculateSignalHash(input.content);
  const ps = input.proof.snarkProof.publicSignals;
  if (signalHash !== BigInt(ps.x)) return { ok: false, reason: 'bad-signal' };
  const expectedRoot = computeRoot(input.rlnIdentifier, input.leaves);
  let valid = false;
  try {
    valid = await verifyRLNProof({
      rlnIdentifier: input.rlnIdentifier,
      proof: input.proof,
      signalHash,
      epoch,
      currentEpoch: input.currentEpoch,
      epochErrorRange: range,
      expectedRoot,
    });
  } catch {
    return { ok: false, reason: 'bad-proof' };
  }
  if (!valid) return { ok: false, reason: 'bad-proof' };
  return { ok: true, epoch, nullifier: String(ps.nullifier), x: String(ps.x), y: String(ps.y) };
}
