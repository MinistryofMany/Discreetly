/**
 * Admin procedure output shapes consumed by the web client. Re-exported from
 * `@discreetly/api`, which derives them from the actual router output, so they
 * cannot drift from the API. The recursive Json fields (`accessPolicy`,
 * `metadata`) are re-typed in the api package to avoid TS2589.
 */
import type {
  AdminRoom,
  AdminMembership,
  AdminLeaf,
  AuditLogRow,
} from '@discreetly/api';

export type {
  AdminRoom,
  AdminMembership,
  AdminLeaf,
  AuditLogRow,
} from '@discreetly/api';

export type RoomVisibility = 'PUBLIC' | 'PRIVATE';
export type RoomEncryption = 'PLAINTEXT' | 'AES';
export type RoomPersistence = 'PERSISTENT' | 'EPHEMERAL';
export type MembershipStatus = 'ACTIVE' | 'BANNED';

/** Cast an untyped tRPC result to AdminRoom[] (the raw client widens deep types). */
export function asAdminRooms(data: unknown): AdminRoom[] {
  return data as AdminRoom[];
}

/** Cast an untyped tRPC result to AdminMembership[]. */
export function asAdminMemberships(data: unknown): AdminMembership[] {
  return data as AdminMembership[];
}

/** Cast an untyped tRPC result to AuditLogRow[]. */
export function asAuditLogRows(data: unknown): AuditLogRow[] {
  return data as AuditLogRow[];
}
