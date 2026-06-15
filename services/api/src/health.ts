import { prisma } from '@discreetly/db';
import { publisher } from './realtime/redis.js';
import { logger } from './log.js';

export interface ReadyResult {
  ok: boolean;
  postgres: boolean;
  redis: boolean;
}

/** Liveness: the process is up and able to respond. */
export function liveness(): { status: 'ok' } {
  return { status: 'ok' };
}

/**
 * Readiness: dependencies (Postgres + Redis) are reachable. Each check is
 * isolated so one failure does not mask the other in the response.
 */
export async function readiness(): Promise<ReadyResult> {
  let postgres = false;
  let redis = false;

  try {
    await prisma.$queryRaw`SELECT 1`;
    postgres = true;
  } catch (err) {
    logger.warn({ err }, 'readiness: postgres check failed');
  }

  try {
    const pong = await publisher().ping();
    redis = pong === 'PONG';
  } catch (err) {
    logger.warn({ err }, 'readiness: redis check failed');
  }

  return { ok: postgres && redis, postgres, redis };
}
