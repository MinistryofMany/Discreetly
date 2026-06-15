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

/** Minimal fields we read out of the proof envelope before the SNARK check. */
interface PreSnarkFields {
  epoch: bigint;
  x: bigint;
  y: bigint;
  root: bigint;
  nullifier: bigint;
}

/**
 * Guard the client-supplied proof envelope. `message.send` accepts `proof:
 * unknown`, so a malformed object (e.g. `{}`) would otherwise throw when we
 * read `proof.epoch` / `proof.snarkProof.publicSignals.*`. Returns null on any
 * missing/uncoercible field so the caller can map it to a typed `bad-proof`
 * rejection instead of a 500.
 */
function extractPreSnarkFields(proof: RLNFullProof): PreSnarkFields | null {
  try {
    const ps = proof.snarkProof?.publicSignals;
    if (
      proof.epoch === undefined ||
      proof.epoch === null ||
      ps === undefined ||
      ps === null ||
      ps.x === undefined ||
      ps.x === null ||
      ps.y === undefined ||
      ps.y === null ||
      ps.root === undefined ||
      ps.root === null ||
      ps.nullifier === undefined ||
      ps.nullifier === null
    ) {
      return null;
    }
    return {
      epoch: BigInt(proof.epoch),
      x: BigInt(ps.x),
      y: BigInt(ps.y),
      root: BigInt(ps.root),
      nullifier: BigInt(ps.nullifier),
    };
  } catch {
    // BigInt(...) throws on a non-numeric string / bad type => malformed proof.
    return null;
  }
}

/** Verify an incoming message's RLN proof. Epoch is the proof-bound value, not client-supplied. */
export async function verifyMessage(input: VerifyMessageInput): Promise<VerifyMessageResult> {
  const fields = extractPreSnarkFields(input.proof);
  if (!fields) return { ok: false, reason: 'bad-proof' };
  const { epoch } = fields;
  const range = input.epochErrorRange ?? 1n;
  if (epoch < input.currentEpoch - range || epoch > input.currentEpoch + range) {
    return { ok: false, reason: 'bad-epoch' };
  }
  const signalHash = calculateSignalHash(input.content);
  if (signalHash !== fields.x) return { ok: false, reason: 'bad-signal' };
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
  return {
    ok: true,
    epoch,
    nullifier: String(fields.nullifier),
    x: String(fields.x),
    y: String(fields.y),
  };
}
