/**
 * Local mirrors of admin procedure outputs. Typed manually to avoid TS2589
 * (recursive Json accessPolicy field) - same pattern as room-types.ts.
 */

export type RoomVisibility = 'PUBLIC' | 'PRIVATE';
export type RoomEncryption = 'PLAINTEXT' | 'AES';
export type RoomPersistence = 'PERSISTENT' | 'EPHEMERAL';
export type MembershipStatus = 'ACTIVE' | 'BANNED';

/** admin.room.list row */
export interface AdminRoom {
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
  _count: {
    memberships: number;
    messages: number;
  };
}

/** admin.room.memberships row (leaf) */
export interface AdminLeaf {
  identityCommitment: string;
  rateCommitment: string;
  deviceLabel: string | null;
  createdAt: string;
}

/** admin.room.memberships row */
export interface AdminMembership {
  status: MembershipStatus;
  joinNullifier: string;
  createdAt: string;
  leaves: AdminLeaf[];
}

/** admin.auditLog row */
export interface AuditLogRow {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  metadata: unknown;
  createdAt: string;
}

/** Cast untyped tRPC result to AdminRoom[] avoiding TS2589 */
export function asAdminRooms(data: unknown): AdminRoom[] {
  return data as unknown as AdminRoom[];
}

/** Cast untyped tRPC result to AdminMembership[] */
export function asAdminMemberships(data: unknown): AdminMembership[] {
  return data as unknown as AdminMembership[];
}

/** Cast untyped tRPC result to AuditLogRow[] */
export function asAuditLogRows(data: unknown): AuditLogRow[] {
  return data as unknown as AuditLogRow[];
}
