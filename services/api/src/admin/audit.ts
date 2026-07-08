import { prisma } from '@discreetly/db';
import type { Prisma } from '@discreetly/db';

/** Audit action verbs. Every producer must pass one of these literals. */
export type AuditAction =
  | 'ROOM_CREATE'
  | 'ROOM_UPDATE'
  | 'ROOM_DELETE'
  | 'ROOM_SEED'
  | 'ADMIN_BAN_IC'
  | 'ADMIN_BAN_NULLIFIER'
  | 'ADMIN_UNBAN'
  | 'RATE_LIMIT_COLLISION'
  | 'SYSTEM_BROADCAST'
  | 'MESSAGE_DELETE';

export interface AuditEntry {
  actor: string;
  action: AuditAction;
  target?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Write an audit row. Accepts an optional Prisma transaction client so it can
 * join a ban transaction; defaults to the shared `prisma` client.
 */
export async function audit(
  entry: AuditEntry,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await client.auditLog.create({ data: entry });
}
