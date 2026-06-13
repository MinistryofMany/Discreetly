import { describe, it, expect } from 'vitest';
import { Identity } from '@semaphore-protocol/identity';
import { poseidon2 } from 'poseidon-lite';
import { calculateSignalHash } from '../signal-hash.js';
import { buildGroup, merkleProofForLeaf } from './merkle.js';
import { generateRLNProof } from './prover.js';
import { verifyRLNProof } from './verifier.js';

describe('RLN prove → verify round-trip', () => {
  it('accepts a valid proof and rejects tampering', async () => {
    const identity = new Identity();
    const rlnIdentifier = 12345n;
    const userMessageLimit = 10n;
    const messageId = 0n;
    const epoch = 42n;

    const rateCommitment = poseidon2([identity.commitment, userMessageLimit]);
    const leaves = [rateCommitment];
    const merkleProof = merkleProofForLeaf(rlnIdentifier, leaves, rateCommitment);
    const expectedRoot = BigInt(buildGroup(rlnIdentifier, leaves).root);
    const x = calculateSignalHash('hello world');

    const proof = await generateRLNProof({
      rlnIdentifier,
      identitySecret: identity.secret,
      userMessageLimit,
      messageId,
      merkleProof,
      x,
      epoch,
    });

    expect(BigInt(proof.snarkProof.publicSignals.x)).toBe(x);
    expect(BigInt(proof.snarkProof.publicSignals.root)).toBe(expectedRoot);

    await expect(
      verifyRLNProof({
        rlnIdentifier,
        proof,
        signalHash: x,
        epoch,
        currentEpoch: epoch,
        expectedRoot,
      }),
    ).resolves.toBe(true);

    await expect(
      verifyRLNProof({
        rlnIdentifier,
        proof,
        signalHash: x + 1n,
        epoch,
        currentEpoch: epoch,
        expectedRoot,
      }),
    ).resolves.toBe(false);

    await expect(
      verifyRLNProof({
        rlnIdentifier,
        proof,
        signalHash: x,
        epoch,
        currentEpoch: epoch + 5n,
        expectedRoot,
      }),
    ).resolves.toBe(false);

    await expect(
      verifyRLNProof({
        rlnIdentifier,
        proof,
        signalHash: x,
        epoch,
        currentEpoch: epoch,
        expectedRoot: expectedRoot + 1n,
      }),
    ).resolves.toBe(false);
  });
});
