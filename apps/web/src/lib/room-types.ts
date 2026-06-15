/**
 * Local mirrors of the non-secret room fields returned by `room.listPublic` and
 * `room.get` (see `PUBLIC_ROOM_FIELDS` in services/api). Typed here rather than
 * inferred from the AppRouter output, whose recursive Json `accessPolicy` field
 * trips TS2589 ("type instantiation is excessively deep").
 */
import type { PolicyNode } from '@discreetly/policy';

export type RoomVisibility = 'PUBLIC' | 'PRIVATE';
export type RoomEncryption = 'PLAINTEXT' | 'AES';
export type RoomPersistence = 'PERSISTENT' | 'EPHEMERAL';

/** Shape returned by `room.listPublic`. */
export interface PublicRoomSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

/** Full non-secret room shape returned by `room.get`. */
export interface PublicRoom {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  rlnIdentifier: string;
  rateLimit: number;
  userMessageLimit: number;
  maxDevices: number;
  visibility: RoomVisibility;
  persistence: RoomPersistence;
  encryption: RoomEncryption;
  accessPolicy: unknown;
  createdAt: string;
  updatedAt: string;
}

/** Coerce the untyped `accessPolicy` JSON into a `PolicyNode` for client use. */
export function asPolicyNode(accessPolicy: unknown): PolicyNode {
  return accessPolicy as PolicyNode;
}
