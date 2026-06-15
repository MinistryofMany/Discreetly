/**
 * Shared fixture for the RLN de-risk spike. The browser spike and the Node
 * Playwright verifier both import these constants so the prove -> verify
 * round-trip uses identical parameters.
 *
 * The seed is a fixed Semaphore serialization (`Identity.toString()` form) so
 * the identity is deterministic across browser and node.
 */
export const SPIKE_RLN_IDENTIFIER = 12345n;
export const SPIKE_USER_MESSAGE_LIMIT = 10n;
export const SPIKE_MESSAGE_ID = 0n;
export const SPIKE_EPOCH = 42n;
export const SPIKE_CONTENT = 'hello world';

/** Deterministic identity seed (trapdoor/nullifier pair, Semaphore v3 format). */
export const SPIKE_IDENTITY_SEED = JSON.stringify([
  '0x1',
  '0x2',
]);

/**
 * Extra (decoy) leaves added alongside this identity's rateCommitment so the
 * group is non-trivial. Arbitrary field elements.
 */
export const SPIKE_DECOY_LEAVES = ['111', '222', '333'] as const;
