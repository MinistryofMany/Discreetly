/**
 * Room shapes consumed by the web client. Re-exported from `@discreetly/api`,
 * which derives them from the actual router output (`inferRouterOutputs`), so a
 * change to a resolver's shape breaks these types instead of drifting silently.
 * The recursive Json `accessPolicy` is re-typed as `PolicyNode` in the api
 * package (indexing the inferred Json type trips TS2589).
 */
import type { PolicyNode } from '@discreetly/policy';

export type { PublicRoom, PublicRoomSummary } from '@discreetly/api';

export type RoomVisibility = 'PUBLIC' | 'PRIVATE';
export type RoomEncryption = 'PLAINTEXT' | 'AES';
export type RoomPersistence = 'PERSISTENT' | 'EPHEMERAL';

/** Coerce a possibly-untyped `accessPolicy` value into a `PolicyNode`. */
export function asPolicyNode(accessPolicy: unknown): PolicyNode {
  return accessPolicy as PolicyNode;
}
