/**
 * GET /api/room-auth/token?pickup=ID - single-use pickup of the fresh per-room
 * id_token minted by the disclosure callback.
 *
 * Returns the verified per-room id_token exactly once and DELETES the flow row,
 * so the token can never be replayed from this endpoint. The client then calls
 * `membership.join({ idToken })` with it; the API gate re-verifies the token and
 * evaluates the room policy inline. The pickup id is an unguessable server-
 * generated cuid handed to the browser only in the callback redirect.
 *
 * Fail-closed: an unknown/expired/already-consumed pickup returns 404 with no
 * token; the client surfaces a re-sign-in prompt.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@discreetly/db';

export async function GET(req: NextRequest): Promise<Response> {
  const pickup = req.nextUrl.searchParams.get('pickup');
  if (!pickup) {
    return NextResponse.json({ error: 'pickup is required' }, { status: 400 });
  }

  const flow = await prisma.roomAuthFlow.findUnique({ where: { id: pickup } });
  if (!flow || flow.idToken === null) {
    return NextResponse.json({ error: 'unknown or already-consumed pickup' }, { status: 404 });
  }

  // Single-use: delete the row before returning the token.
  await prisma.roomAuthFlow.delete({ where: { id: flow.id } }).catch(() => {});

  if (flow.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: 'expired' }, { status: 404 });
  }

  return NextResponse.json({ roomId: flow.roomId, idToken: flow.idToken });
}
