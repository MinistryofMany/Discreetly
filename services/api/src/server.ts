import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { WebSocketServer } from 'ws';
import { appRouter } from './trpc/app.router.js';
import { getProductionVerifier } from './minister/production-verifier.js';
import { getConfig, parseOperatorSubs } from './config.js';
import { logger } from './log.js';
import { checkRateLimit } from './middleware/rate-limit.js';
import { liveness, readiness } from './health.js';

export type { AppRouter } from './trpc/app.router.js';
export type {
  PublicRoom,
  PublicRoomSummary,
  AdminRoom,
  AdminLeaf,
  AdminMembership,
  AuditLogRow,
  BanRow,
  MessageListItem,
} from './trpc/outputs.js';
export type {
  RoomBroadcast,
  ChatBroadcast,
  SystemBroadcast,
  TombstoneBroadcast,
} from './realtime/broadcast.js';
export { TOMBSTONE_MARKER } from './realtime/broadcast.js';
export { MAX_ROOM_MESSAGES } from './messaging/history.js';

const config = getConfig();
const { API_PORT, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, RATE_LIMIT_MUTATION_MAX, TRUST_PROXY } =
  config;

// Operator allowlist for admin procedures, parsed once at boot. An empty set
// means no operator exists (fail closed) - warn loudly so a misconfigured
// deployment is diagnosable from the boot log instead of a silent FORBIDDEN.
const operatorSubs = parseOperatorSubs(config.DISCREETLY_OPERATOR_SUBS);
if (operatorSubs.size === 0) {
  logger.warn(
    'DISCREETLY_OPERATOR_SUBS is unset or empty: no operator is configured and every admin call will be FORBIDDEN. Set it to a comma-separated list of Minister pairwise subs.',
  );
} else {
  logger.info({ operators: operatorSubs.size }, 'operator allowlist loaded');
}

/**
 * Browser origins allowed for both WS connections and HTTP CORS. A request with
 * no Origin header is a non-browser client (curl, server-to-server, tests) and
 * is allowed; a present-but-not-allowlisted Origin is refused (no ACAO echoed).
 */
const allowedOrigins = (
  process.env.ALLOWED_WS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function isOriginAllowed(origin: string | undefined): boolean {
  return !!origin && allowedOrigins.includes(origin);
}

/**
 * Apply CORS headers reflecting the allowlist. If the Origin is allowlisted,
 * echo it (with `Vary: Origin` so caches key on it). If there is no Origin
 * header, allow the request without setting ACAO (non-browser client). If an
 * Origin is present but not allowlisted, set no ACAO so the browser blocks the
 * cross-origin read.
 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  res.setHeader('Vary', 'Origin');
  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin!);
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

/** Extract the token from an `Authorization: Bearer <token>` header value. */
function bearer(headerValue?: string | string[]): string | undefined {
  if (!headerValue) return undefined;
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) return undefined;
  const [scheme, token] = value.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
  return token;
}

/**
 * Derive the client IP. Behind a trusted proxy, use the leftmost
 * `x-forwarded-for` entry (the originating client); otherwise trust only the
 * socket peer address (an attacker can spoof XFF when not behind a proxy).
 */
function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    // SECURITY: TRUST_PROXY=true is only safe behind a front proxy that strips
    // or overwrites any client-supplied X-Forwarded-For. Without that, the
    // leftmost entry is attacker-spoofable and defeats per-IP rate limiting.
    const xff = req.headers['x-forwarded-for'];
    const value = Array.isArray(xff) ? xff[0] : xff;
    const first = value?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const httpServer = createHTTPServer({
  router: appRouter,
  // The web client sends queries as POST (methodOverride) so query inputs (and
  // the id_token) never end up in the URL. The HTTP adapter must opt in to
  // accept POST for query procedures.
  allowMethodOverride: true,
  middleware: (req, res, next) => {
    // Health/readiness bypass CORS, auth, and rate limiting entirely.
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, liveness());
      return;
    }
    if (req.method === 'GET' && path === '/ready') {
      readiness()
        .then((r) => sendJson(res, r.ok ? 200 : 503, r))
        .catch((err) => {
          logger.error({ err }, 'readiness check threw');
          sendJson(res, 503, { ok: false });
        });
      return;
    }

    applyCors(req, res);
    // Short-circuit preflight BEFORE rate limiting so OPTIONS is never limited.
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Per-IP rate limiting. POST (mutations + method-overridden queries) uses
    // the stricter mutation bucket; GET uses the looser query bucket.
    const ip = clientIp(req);
    const isMutation = req.method === 'POST';
    const bucket = isMutation ? 'mut' : 'qry';
    const max = isMutation ? RATE_LIMIT_MUTATION_MAX : RATE_LIMIT_MAX;
    checkRateLimit(`http:${bucket}:${ip}`, max, RATE_LIMIT_WINDOW_MS)
      .then((result) => {
        if (!result.allowed) {
          const retryAfter = Math.ceil(result.resetMs / 1000);
          res.setHeader('Retry-After', String(retryAfter));
          sendJson(res, 429, { error: 'rate_limited', retryAfterSeconds: retryAfter });
          return;
        }
        next();
      })
      .catch((err) => {
        // Fail open on limiter errors (e.g. Redis blip) rather than dropping
        // legitimate traffic; the failure is logged for investigation.
        logger.error({ err }, 'rate limit check failed; allowing request');
        next();
      });
  },
  createContext: ({ req }) => ({
    verify: getProductionVerifier(),
    adminIdToken: bearer(req.headers.authorization),
    operatorSubs,
  }),
});

// Concurrent WS connections per IP (in-memory; WS conns are sticky to one
// instance, so per-instance counting is correct for a connection cap).
const wsConnsByIp = new Map<string, number>();

const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: (info, cb) => {
    const origin = info.origin;
    // No Origin = non-browser client (allowed). Browser origins must be allowlisted.
    if (origin && !isOriginAllowed(origin)) {
      cb(false, 403, 'Forbidden origin');
      return;
    }
    const ip = clientIp(info.req);
    const active = wsConnsByIp.get(ip) ?? 0;
    if (active >= config.RATE_LIMIT_WS_MAX_PER_IP && config.RATE_LIMIT_ENABLED) {
      cb(false, 429, 'Too Many Connections');
      return;
    }
    cb(true);
  },
});

wss.on('connection', (socket, req) => {
  const ip = clientIp(req);
  wsConnsByIp.set(ip, (wsConnsByIp.get(ip) ?? 0) + 1);
  socket.once('close', () => {
    const next = (wsConnsByIp.get(ip) ?? 1) - 1;
    if (next <= 0) wsConnsByIp.delete(ip);
    else wsConnsByIp.set(ip, next);
  });
});

applyWSSHandler({
  wss,
  router: appRouter,
  // No Authorization header rides the WS upgrade from browsers, so admin
  // procedures are HTTP-only; operatorSubs is still threaded for completeness.
  createContext: () => ({ verify: getProductionVerifier(), operatorSubs }),
});

httpServer.listen(API_PORT);
logger.info({ port: API_PORT, url: `http://localhost:${API_PORT}` }, 'tRPC HTTP listening');
logger.info({ port: API_PORT, url: `ws://localhost:${API_PORT}` }, 'tRPC WS listening');
