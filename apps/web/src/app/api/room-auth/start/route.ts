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
import type { PolicyNode } from '@discreetly/policy';
import { scopesToRequestForRoom } from '@/lib/badges';
import { encodeMinisterPolicy } from '@/lib/minister-policy';
import { ministerClientForRoomAuth, ROOM_AUTH_FLOW_TTL_MS } from '@/lib/room-auth';

export async function GET(req: NextRequest): Promise<Response> {
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
