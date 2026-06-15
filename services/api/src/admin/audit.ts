import { prisma } from '@discreetly/db';
import type { Prisma } from '@discreetly/db';

export interface AuditEntry {
  actor: string;
  action: string;
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
