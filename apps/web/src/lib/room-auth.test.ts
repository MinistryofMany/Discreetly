// @vitest-environment node
/**
 * DB-backed test for the per-room disclosure flow's expired-row sweep (audit
 * L-2). `sweepExpiredRoomAuthFlows` must delete only already-expired
 * `RoomAuthFlow` rows and never touch a live in-flight flow, so the
 * unauthenticated `/api/room-auth/start` endpoint cannot let short-lived rows
 * accumulate. Runs against the real dev Postgres (like packages/db's smoke
 * test); rows are namespaced and cleaned up.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { prisma } from '@discreetly/db';
import { sweepExpiredRoomAuthFlows, ROOM_AUTH_FLOW_TTL_MS } from './room-auth.js';

const TAG = `l2-sweep-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdIds: string[] = [];

async function makeFlow(label: string, expiresAt: Date): Promise<string> {
  const row = await prisma.roomAuthFlow.create({
    data: {
      state: `${TAG}-state-${label}`,
      nonce: `${TAG}-nonce-${label}`,
      codeVerifier: `${TAG}-cv-${label}`,
      roomId: `${TAG}-room`,
      expiresAt,
    },
  });
  createdIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  // Sanity: the dev DB must be reachable (loadEnv wired DATABASE_URL in).
  await prisma.$queryRawUnsafe('SELECT 1');
});

afterAll(async () => {
  await prisma.roomAuthFlow.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.$disconnect();
});

describe('sweepExpiredRoomAuthFlows', () => {
  it('deletes expired rows and leaves live rows intact', async () => {
    const expiredId = await makeFlow('expired', new Date(Date.now() - 60_000));
    const liveId = await makeFlow('live', new Date(Date.now() + ROOM_AUTH_FLOW_TTL_MS));

    const removed = await sweepExpiredRoomAuthFlows();
    expect(removed).toBeGreaterThanOrEqual(1);

    const expired = await prisma.roomAuthFlow.findUnique({ where: { id: expiredId } });
    const live = await prisma.roomAuthFlow.findUnique({ where: { id: liveId } });
    expect(expired).toBeNull();
    expect(live).not.toBeNull();
  });
});
