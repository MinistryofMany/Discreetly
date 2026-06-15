/**
 * Explicit, wire-accurate output types for the procedures the web client
 * consumes. Derived from the router via `inferRouterOutputs` so they cannot
 * drift from the actual API: a resolver shape change breaks the type here.
 *
 * The recursive Json columns (`accessPolicy`, audit `metadata`) are the one
 * thing we cannot infer directly - indexing into them trips TS2589 ("type
 * instantiation is excessively deep"). They are `Omit`ted from the inferred
 * shape and re-declared with the precise application type (`PolicyNode`) or
 * `unknown`, which is also what the client needs.
 */
import type { inferRouterOutputs } from '@trpc/server';
import type { PolicyNode } from '@discreetly/policy';
import type { AppRouter } from './app.router.js';

type Outputs = inferRouterOutputs<AppRouter>;

/** Full non-secret room shape returned by `room.get`. */
export type PublicRoom = Omit<NonNullable<Outputs['room']['get']>, 'accessPolicy'> & {
  accessPolicy: PolicyNode;
};

/**
 * Row shape returned by `room.listPublic`. Same non-secret fields as `room.get`
 * (both select `PUBLIC_ROOM_FIELDS`), with `accessPolicy` typed as `PolicyNode`.
 */
export type PublicRoomSummary = Omit<
  Outputs['room']['listPublic'][number],
  'accessPolicy'
> & { accessPolicy: PolicyNode };

/** Row shape returned by `admin.room.list` (PublicRoom + membership/message counts). */
export type AdminRoom = Omit<Outputs['admin']['room']['list'][number], 'accessPolicy'> & {
  accessPolicy: PolicyNode;
};

/** A device (leaf) row inside an admin membership. */
export type AdminLeaf = Outputs['admin']['room']['memberships'][number]['leaves'][number];

/** Row shape returned by `admin.room.memberships`. */
export type AdminMembership = Outputs['admin']['room']['memberships'][number];

/** Row shape returned by `admin.auditLog`. */
export type AuditLogRow = Omit<Outputs['admin']['auditLog'][number], 'metadata'> & {
  metadata: unknown;
};

/** A persisted message row returned by `message.list`. */
export type MessageListItem = Outputs['message']['list'][number];
