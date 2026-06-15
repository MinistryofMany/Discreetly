import { Identity } from '@semaphore-protocol/identity';
import { poseidon2 } from 'poseidon-lite';
import { calculateSignalHash } from '@discreetly/crypto';
import { generateRLNProof, merkleProofForLeaf } from '@discreetly/crypto/rln';
import type { RLNFullProof } from 'rlnjs';

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
): Promise<RLNFullProof> {
  const merkleProof = merkleProofForLeaf(ctx.rlnIdentifier, ctx.leaves, ctx.rateCommitment);
  return generateRLNProof({
    rlnIdentifier: ctx.rlnIdentifier,
    identitySecret: ctx.identity.secret,
    userMessageLimit: ctx.userMessageLimit,
    messageId,
    merkleProof,
    x: calculateSignalHash(message),
    epoch,
  });
}
