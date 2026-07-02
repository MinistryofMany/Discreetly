import { Identity } from '@semaphore-protocol/identity';
import { poseidon2 } from 'poseidon-lite';
import { calculateSignalHash, generateRlnProof, staticArtifactSource } from '@ministryofmany/rln';
import type { RlnProof } from '@ministryofmany/rln';
import { rlnWasmPath, rlnZkeyPath } from '@discreetly/circuits';

export interface ProofCtx {
  identity: Identity;
  rlnIdentifier: bigint;
  userMessageLimit: bigint;
  rateCommitment: bigint;
  leaves: bigint[];
}

export function makeProofCtx(rlnIdentifier = 12345n, userMessageLimit = 1n): ProofCtx {
  const identity = new Identity();
  const rateCommitment = poseidon2([identity.commitment, userMessageLimit]);
  return { identity, rlnIdentifier, userMessageLimit, rateCommitment, leaves: [rateCommitment] };
}

/** Generate a real RLN proof for `message` at `epoch`. Reuse the same messageId+epoch with different messages to force a collision. */
export async function proofFor(
  ctx: ProofCtx,
  message: string,
  epoch: bigint,
  messageId = 0n,
): Promise<RlnProof> {
  return generateRlnProof(
    {
      rlnIdentifier: ctx.rlnIdentifier,
      identitySecret: ctx.identity.secret,
      userMessageLimit: ctx.userMessageLimit,
      messageId,
      leaves: ctx.leaves,
      leaf: ctx.rateCommitment,
      x: calculateSignalHash(message),
      epoch,
    },
    staticArtifactSource({ prover: { wasm: rlnWasmPath, zkey: rlnZkeyPath } }),
  );
}
