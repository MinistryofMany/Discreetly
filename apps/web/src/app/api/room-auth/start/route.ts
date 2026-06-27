/**
 * GET /api/room-auth/start?roomId=R - begin the per-room SDK disclosure flow.
 *
 * Mints PKCE+state+nonce, persists the flow state (keyed by `state`, consumed
 * delete-on-read at the callback), builds the Minister authorize URL via the SDK
 * with the room's UNION badge scope + `minister_policy`, and redirects the
 * browser to Minister. Minister selects the minimal satisfying set at consent
 * and mints a fresh per-room id_token; the callback exchanges it.
 *
 * Over-disclosure-to-RP: the authorize requests the room's UNION scope and the
 * `minister_policy` AST; Minister discloses exactly one minimal satisfying set
 * (Phase 2 `minimizeToPolicy`), and the inline gate sees only that token.
 * Fail-closed: an unknown room, a malformed policy, or a missing config rejects
 * the start with no redirect.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@discreetly/db';
import { checkRateLimit } from '@discreetly/api/rate-limit';
import type { PolicyNode } from '@discreetly/policy';
import { scopesToRequestForRoom } from '@/lib/badges';
import { encodeMinisterPolicy } from '@/lib/minister-policy';
import {
  clientIpForRateLimit,
  ministerClientForRoomAuth,
  ROOM_AUTH_FLOW_TTL_MS,
  ROOM_AUTH_START_RATE_LIMIT_MAX,
  ROOM_AUTH_START_RATE_LIMIT_WINDOW_MS,
  sweepExpiredRoomAuthFlows,
} from '@/lib/room-auth';

export async function GET(req: NextRequest): Promise<Response> {
  // Per-IP abuse limit on this unauthenticated, row-creating endpoint. Reuses
  // the API's Redis fixed-window limiter (`@discreetly/api/rate-limit`) - the
  // same atomic counter the transport layer uses - keyed in its own `room-auth`
  // bucket so it never shares a budget with the tRPC traffic. Fail-closed only
  // on an explicit limit; a limiter error (e.g. Redis blip) falls open so a real
  // join is never dropped, matching the API's behaviour.
  const ip = clientIpForRateLimit(req);
  try {
    const limit = await checkRateLimit(
      `room-auth:start:${ip}`,
      ROOM_AUTH_START_RATE_LIMIT_MAX,
      ROOM_AUTH_START_RATE_LIMIT_WINDOW_MS,
    );
    if (!limit.allowed) {
      const retryAfter = Math.ceil(limit.resetMs / 1000);
      return NextResponse.json(
        { error: 'rate_limited', retryAfterSeconds: retryAfter },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } },
      );
    }
  } catch (error) {
    console.warn(
      'room-auth start rate limit check failed; allowing request:',
      error instanceof Error ? error.message : String(error),
    );
  }

  // Opportunistic prune of expired flow rows so this unauthenticated endpoint
  // cannot let short-lived rows accumulate unbounded. Indexed on `expiresAt`,
  // scoped to already-expired rows only, and best-effort (a sweep failure never
  // blocks a legitimate start).
  await sweepExpiredRoomAuthFlows();

  const roomId = req.nextUrl.searchParams.get('roomId');
  if (!roomId) {
    return NextResponse.json({ error: 'roomId is required' }, { status: 400 });
  }

  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) {
    return NextResponse.json({ error: 'no-room' }, { status: 404 });
  }

  const policy = room.accessPolicy as unknown as PolicyNode;
  const scopes = scopesToRequestForRoom(policy);
  const ministerPolicy = encodeMinisterPolicy(policy);

  const client = ministerClientForRoomAuth();
  const { verifier: codeVerifier, challenge } = await client.generatePkce();
  const state = client.randomToken();
  const nonce = client.randomToken();

  // Persist the pre-redirect flow state. The callback consumes it by `state`.
  await prisma.roomAuthFlow.create({
    data: {
      state,
      nonce,
      codeVerifier,
      roomId,
      expiresAt: new Date(Date.now() + ROOM_AUTH_FLOW_TTL_MS),
    },
  });

  // Build the authorize URL. `minister_policy` is omitted (fail-closed) only if
  // the policy could not be encoded; the room's UNION scope still goes, and the
  // server gate stays authoritative.
  const extraParams: Record<string, string> = {};
  if (ministerPolicy !== null) extraParams.minister_policy = ministerPolicy;

  const url = await client.getAuthorizationUrl({
    scopes,
    state,
    nonce,
    codeChallenge: challenge,
    extraParams,
  });

  return NextResponse.redirect(url);
}
