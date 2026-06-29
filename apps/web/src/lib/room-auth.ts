/**
 * Per-room disclosure flow (Phase 3 / Path B), server-side.
 *
 * The per-room badge disclosure no longer rides Auth.js's third-`signIn`-arg
 * merge. It runs the framework-agnostic `@ministryofmany/client` auth-code+PKCE flow
 * directly at two dedicated RP routes:
 *
 *   GET /api/room-auth/start?roomId=R    -> mint PKCE+state+nonce, persist the
 *      flow state (delete-on-read), build the authorize URL with the room's
 *      `minister_policy`, and redirect to Minister.
 *   GET /api/room-auth/callback (redirectUri) -> look the flow up by `state`,
 *      `exchangeCode` (verifies id_token signature/iss/aud/nonce + badges),
 *      store the FRESH verified per-room id_token back on the row, and redirect
 *      to the room with the row id as a single-use pickup token.
 *   GET /api/room-auth/token?pickup=ID   -> return the fresh id_token once and
 *      delete the row; the client forwards it to `membership.join`.
 *
 * This module owns the SDK client construction and the redirect URI so both
 * routes agree. The SDK already returns the VERIFIED id_token claims + badges
 * from `exchangeCode`, so the RP forwards `claims.raw` straight to the inline
 * gate - no next-auth internals, no durable badge store.
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@discreetly/db';
import { createMinisterClient, type MinisterClient } from '@ministryofmany/client';

/** The fixed redirect URI registered with Minister for the per-room flow. */
export function roomAuthRedirectUri(): string {
  // AUTH_URL is the app origin (set in every runtime; Auth.js requires it too).
  const base = process.env.AUTH_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
  return `${base.replace(/\/$/, '')}/api/room-auth/callback`;
}

/** Construct the Minister SDK client bound to this RP's credentials. */
export function ministerClientForRoomAuth(): MinisterClient {
  const issuer = process.env.MINISTER_ISSUER;
  const clientId = process.env.MINISTER_CLIENT_ID;
  if (!issuer) throw new Error('MINISTER_ISSUER is required for the per-room disclosure flow');
  if (!clientId) throw new Error('MINISTER_CLIENT_ID is required for the per-room disclosure flow');
  return createMinisterClient({
    issuer,
    clientId,
    // The token exchange is confidential-client; the secret is server-only.
    clientSecret: process.env.MINISTER_CLIENT_SECRET,
    redirectUri: roomAuthRedirectUri(),
  });
}

/** How long a per-room flow row may live before the callback/pickup is rejected. */
export const ROOM_AUTH_FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Per-IP abuse limit for the unauthenticated `/api/room-auth/start` endpoint.
 * Matches the API transport layer's mutation bucket (the stricter, state-
 * changing bucket): 30 starts per minute per IP. A real join needs only a
 * handful of starts, so this is generous for users while bounding flooding of
 * the short-lived `RoomAuthFlow` rows / room-existence probing. Overridable via
 * the same `RATE_LIMIT_*` env knobs the API already documents.
 */
export const ROOM_AUTH_START_RATE_LIMIT_WINDOW_MS = Number(
  process.env.RATE_LIMIT_WINDOW_MS ?? 60_000,
);
export const ROOM_AUTH_START_RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MUTATION_MAX ?? 30);

/**
 * Derive the client IP for rate-limit keying. Behind a trusted proxy
 * (`TRUST_PROXY=true`, the prod deployment where nginx sets the header), use the
 * leftmost `X-Forwarded-For` entry (the originating client); otherwise the
 * header is attacker-spoofable, so fall back to `x-real-ip` and finally a
 * constant bucket. Mirrors the API's `clientIp` semantics.
 */
export function clientIpForRateLimit(req: NextRequest): string {
  if (process.env.TRUST_PROXY === 'true') {
    const xff = req.headers.get('x-forwarded-for');
    const first = xff?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * Opportunistic prune of expired `RoomAuthFlow` rows. Cheap (indexed on
 * `expiresAt`), scoped strictly to already-expired rows so it can never delete a
 * live in-flight flow, and best-effort: a failure is logged and swallowed so it
 * never blocks a legitimate start/callback. Returns the number of rows removed.
 *
 * The `RoomAuthFlow` row is the only single-use row in this flow - it also backs
 * the post-callback `idToken` pickup (`/api/room-auth/token` deletes on read).
 * The token-pickup path already deletes its row on read; this sweep covers rows
 * abandoned before pickup (a started flow whose callback never returns).
 */
export async function sweepExpiredRoomAuthFlows(): Promise<number> {
  try {
    const { count } = await prisma.roomAuthFlow.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return count;
  } catch (error) {
    console.warn(
      'room-auth expired-flow sweep failed:',
      error instanceof Error ? error.message : String(error),
    );
    return 0;
  }
}
