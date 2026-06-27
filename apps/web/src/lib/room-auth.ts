/**
 * Per-room disclosure flow (Phase 3 / Path B), server-side.
 *
 * The per-room badge disclosure no longer rides Auth.js's third-`signIn`-arg
 * merge. It runs the framework-agnostic `@minister/client` auth-code+PKCE flow
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
import { createMinisterClient, type MinisterClient } from '@minister/client';

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
