/**
 * In-browser RLN proving.
 *
 * Mirrors `packages/crypto/src/rln/rln.roundtrip.test.ts` so proofs generated
 * here are accepted by `services/api` `verifyRLNProof`:
 *   - leaf = rateCommitment = poseidon2([identityCommitment, userMessageLimit])
 *   - group = buildGroup(rlnIdentifier, leaves)  (MERKLE_TREE_DEPTH = 20)
 *   - x = calculateSignalHash(content)
 *   - epoch = floor(Date.now() / rateLimitMs)  (matches pipeline.ts)
 */
import type { RLNFullProof } from 'rlnjs';
import { calculateSignalHash, getRateCommitmentHash } from '@discreetly/crypto';
import { buildGroup, merkleProofForLeaf, generateRLNProof } from '@discreetly/crypto/rln';
import type { AppIdentity } from './identity';

const ARTIFACT_BASE = '/circuits/rln';

interface Artifacts {
  wasm: Uint8Array;
  zkey: Uint8Array;
}

let artifactsPromise: Promise<Artifacts> | null = null;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch RLN artifact ${url}: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Fetch and cache the wasm + zkey artifacts (module-scoped, single-flight). */
export async function getArtifacts(): Promise<Artifacts> {
  if (artifactsPromise === null) {
    artifactsPromise = (async () => {
      const [wasm, zkey] = await Promise.all([
        fetchBytes(`${ARTIFACT_BASE}/circuit.wasm`),
        fetchBytes(`${ARTIFACT_BASE}/final.zkey`),
      ]);
      return { wasm, zkey };
    })().catch((err) => {
      // Reset so a transient failure can be retried.
      artifactsPromise = null;
      throw err;
    });
  }
  return artifactsPromise;
}

/**
 * Current RLN epoch, matching the server: `floor(Date.now() / rateLimitMs)`.
 * (`pipeline.ts`: `BigInt(Math.floor(Date.now() / room.rateLimit))`.)
 */
export function currentEpoch(rateLimitMs: number, now: number = Date.now()): bigint {
  if (!Number.isFinite(rateLimitMs) || rateLimitMs <= 0) {
    throw new Error(`Invalid rateLimitMs: ${rateLimitMs}`);
  }
  return BigInt(Math.floor(now / rateLimitMs));
}

// --- per-(room, epoch) messageId counter, persisted in localStorage ---

const COUNTER_PREFIX = 'discreetly.msgcounter.v1';

interface CounterState {
  epoch: string;
  next: number;
}

function counterKey(roomId: string): string {
  return `${COUNTER_PREFIX}.${roomId}`;
}

/**
 * Reserve the next `messageId` for (room, epoch), bounded by `userMessageLimit`.
 * Counter resets when the epoch rolls over. Returns the reserved id (0-based).
 * Throws if the room's rate limit for this epoch is exhausted.
 */
export function nextMessageId(
  roomId: string,
  epoch: bigint,
  userMessageLimit: bigint,
): bigint {
  if (typeof localStorage === 'undefined') {
    throw new Error('localStorage is not available; cannot track messageId.');
  }
  const key = counterKey(roomId);
  const epochStr = epoch.toString();
  let state: CounterState = { epoch: epochStr, next: 0 };
  const raw = localStorage.getItem(key);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as CounterState;
      if (parsed.epoch === epochStr && Number.isInteger(parsed.next)) {
        state = parsed;
      }
    } catch {
      // Corrupt counter -> start fresh for this epoch.
    }
  }
  if (BigInt(state.next) >= userMessageLimit) {
    throw new Error(
      `Rate limit reached for this room/epoch (limit ${userMessageLimit.toString()}).`,
    );
  }
  const reserved = BigInt(state.next);
  localStorage.setItem(key, JSON.stringify({ epoch: epochStr, next: state.next + 1 }));
  return reserved;
}

export interface ProveMessageInput {
  rlnIdentifier: bigint;
  /** The room's current leaf set (rateCommitments) from `room.leaves`. */
  leaves: readonly (string | bigint)[];
  identity: AppIdentity;
  content: string;
  userMessageLimit: bigint;
  messageId: bigint;
  epoch: bigint;
}

/**
 * Build and return an RLN proof for `content` from this identity within the
 * room's leaf set. The identity's rateCommitment MUST be present in `leaves`
 * (i.e. the identity is a joined member), otherwise the Merkle proof build
 * throws.
 */
export async function proveMessage(input: ProveMessageInput): Promise<RLNFullProof> {
  const { wasm, zkey } = await getArtifacts();
  const rateCommitment = getRateCommitmentHash(input.identity.commitment, input.userMessageLimit);
  const merkleProof = merkleProofForLeaf(input.rlnIdentifier, input.leaves, rateCommitment);
  const x = calculateSignalHash(input.content);
  return generateRLNProof(
    {
      rlnIdentifier: input.rlnIdentifier,
      identitySecret: input.identity.secret,
      userMessageLimit: input.userMessageLimit,
      messageId: input.messageId,
      merkleProof,
      x,
      epoch: input.epoch,
    },
    { wasm, zkey },
  );
}

/** The rateCommitment leaf this identity contributes for a given room limit. */
export function rateCommitmentFor(identity: AppIdentity, userMessageLimit: bigint): bigint {
  return getRateCommitmentHash(identity.commitment, userMessageLimit);
}

export { buildGroup };
