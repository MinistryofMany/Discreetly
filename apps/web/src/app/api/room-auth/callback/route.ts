/**
 * GET /api/room-auth/callback - the registered redirectUri for the per-room SDK
 * disclosure flow.
 *
 * Looks the flow up by `state` (delete-on-read of the PKCE secret), runs
 * `exchangeCode` (the SDK verifies the id_token signature/iss/aud/nonce and each
 * disclosed badge), stores the FRESH verified per-room id_token back on the flow
 * row, and redirects the browser to the room with the row id as a single-use
 * pickup token (`?roomAuthPickup=<id>`). The client picks the token up once and
 * forwards it to `membership.join`, where the inline gate evaluates the room
 * policy on this exact token.
 *
 * Fail-closed: an unknown/expired `state`, a missing code, or any verification
 * failure in `exchangeCode` redirects back to the room with `?roomAuthError=1`
 * and never admits. The flow row is consumed regardless so a `state` is never
 * replayable.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@discreetly/db';
import { ministerClientForRoomAuth } from '@/lib/room-auth';

function backToRoom(roomId: string, params: Record<string, string>): Response {
  const base = (process.env.AUTH_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const u = new URL(`${base}/rooms/${roomId}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return NextResponse.redirect(u.toString());
}

function errorResponse(message: string): Response {
  // No room context to bounce back to (bad/absent state) - render a terminal error.
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(req: NextRequest): Promise<Response> {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');

  if (!state) return errorResponse('missing state');

  // Atomically consume the flow by `state`: null the PKCE secret only if it is
  // still set, so two concurrent callbacks for the same `state` can never both
  // proceed (single-use). The losing request sees count 0 and is rejected.
  const flow = await prisma.roomAuthFlow.findUnique({ where: { state } });
  if (!flow || flow.codeVerifier === null) {
    return errorResponse('unknown or already-consumed state');
  }
  const consumed = await prisma.roomAuthFlow.updateMany({
    where: { state, codeVerifier: { not: null } },
    data: { codeVerifier: null },
  });
  if (consumed.count === 0) {
    return errorResponse('unknown or already-consumed state');
  }

  const expired = flow.expiresAt.getTime() < Date.now();
  if (expired) {
    await prisma.roomAuthFlow.delete({ where: { id: flow.id } }).catch(() => {});
    return backToRoom(flow.roomId, { roomAuthError: 'expired' });
  }
  if (!code) {
    await prisma.roomAuthFlow.delete({ where: { id: flow.id } }).catch(() => {});
    return backToRoom(flow.roomId, { roomAuthError: '1' });
  }

  try {
    const client = ministerClientForRoomAuth();
    const { claims } = await client.exchangeCode({
      code,
      codeVerifier: flow.codeVerifier!,
      expectedNonce: flow.nonce,
    });
    // claims.raw is the VERIFIED fresh id_token (signature/iss/aud/nonce checked,
    // badges verified). Store it on the row for one-time pickup; the API gate
    // re-verifies it independently on join (it is the sole authority).
    await prisma.roomAuthFlow.update({
      where: { id: flow.id },
      data: { idToken: claims.raw, nonce: '' },
    });
    return backToRoom(flow.roomId, { roomAuthPickup: flow.id });
  } catch (error) {
    // Fail-closed: any verification failure denies. Log only a safe summary -
    // never the code, id_token, or any badge VC.
    console.warn(
      'per-room disclosure exchange failed:',
      error instanceof Error ? error.message : String(error),
    );
    await prisma.roomAuthFlow.delete({ where: { id: flow.id } }).catch(() => {});
    return backToRoom(flow.roomId, { roomAuthError: '1' });
  }
}
