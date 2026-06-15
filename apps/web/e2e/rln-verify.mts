/**
 * Node-side RLN verifier for the de-risk spike, run via `tsx` so it can import
 * the workspace crypto TS source (which Playwright's own loader cannot resolve).
 *
 * Reads a JSON object on stdin: `{ proof }` where `proof` is the
 * browser-generated RLNFullProof (bigints as strings). The leaf set is rebuilt
 * here from the shared fixture so `expectedRoot` matches the proof's public
 * root. Prints `VALID` or `INVALID` on stdout.
 */
import { Identity } from '@semaphore-protocol/identity';
import { verifyRLNProof, computeRoot } from '@discreetly/crypto/rln';
import { calculateSignalHash, getRateCommitmentHash } from '@discreetly/crypto';
import {
  SPIKE_CONTENT,
  SPIKE_DECOY_LEAVES,
  SPIKE_EPOCH,
  SPIKE_IDENTITY_SEED,
  SPIKE_RLN_IDENTIFIER,
  SPIKE_USER_MESSAGE_LIMIT,
} from '../src/app/dev/rln-spike/fixture.js';

interface RawProof {
  snarkProof: { proof: unknown; publicSignals: Record<string, string> };
  epoch: string;
  rlnIdentifier: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** Rebuild the exact leaf set the browser spike constructed. */
function expectedLeaves(): string[] {
  const id = new Identity(SPIKE_IDENTITY_SEED);
  const leaf = getRateCommitmentHash(id.commitment, SPIKE_USER_MESSAGE_LIMIT);
  return [leaf.toString(), ...SPIKE_DECOY_LEAVES];
}

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin()) as { proof: RawProof };
  const raw = input.proof;

  // Rehydrate bigints the crypto verifier expects.
  const proof = {
    snarkProof: raw.snarkProof,
    epoch: BigInt(raw.epoch),
    rlnIdentifier: BigInt(raw.rlnIdentifier),
  } as unknown as Parameters<typeof verifyRLNProof>[0]['proof'];

  const signalHash = calculateSignalHash(SPIKE_CONTENT);
  const expectedRoot = computeRoot(SPIKE_RLN_IDENTIFIER, expectedLeaves());

  const valid = await verifyRLNProof({
    rlnIdentifier: SPIKE_RLN_IDENTIFIER,
    proof,
    signalHash,
    epoch: SPIKE_EPOCH,
    currentEpoch: SPIKE_EPOCH,
    expectedRoot,
  });

  process.stdout.write(valid ? 'VALID\n' : 'INVALID\n');
  process.exit(valid ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`ERROR ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
