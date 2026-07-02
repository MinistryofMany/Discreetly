import {
  verifyRlnProof,
  computeRoot,
  calculateSignalHash,
  staticArtifactSource,
} from '@ministryofmany/rln';
import type { RlnProof, RlnVerificationKey } from '@ministryofmany/rln';
import { rlnVerificationKey } from '@discreetly/circuits';

// Inject the depth-20 Groth16 verification key once at module scope. The
// artifacts are NOT bundled by @ministryofmany/rln (it is circuit-agnostic);
// the app supplies them from @discreetly/circuits, which stays local. Building
// this once (not per call) keeps the verify path allocation-free and makes a
// missing key fail loudly at startup rather than silently per message.
const RLN_ARTIFACTS = staticArtifactSource({
  verificationKey: rlnVerificationKey as RlnVerificationKey,
});

export interface VerifyMessageInput {
  rlnIdentifier: bigint;
  proof: RlnProof;
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
function extractPreSnarkFields(proof: RlnProof): PreSnarkFields | null {
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
    valid = await verifyRlnProof(
      {
        rlnIdentifier: input.rlnIdentifier,
        proof: input.proof,
        signalHash,
        epoch,
        currentEpoch: input.currentEpoch,
        epochErrorRange: range,
        expectedRoot,
      },
      RLN_ARTIFACTS,
    );
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
