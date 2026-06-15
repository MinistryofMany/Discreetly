import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { WebSocketServer } from 'ws';
import { appRouter } from './trpc/app.router.js';
import { getProductionVerifier } from './minister/production-verifier.js';
import { getConfig } from './config.js';

const { API_PORT } = getConfig();

/** Extract the token from an `Authorization: Bearer <token>` header value. */
function bearer(headerValue?: string): string | undefined {
  if (!headerValue) return undefined;
  const [scheme, token] = headerValue.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
  return token;
}

const httpServer = createHTTPServer({
  router: appRouter,
  middleware: (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    next();
  },
  createContext: ({ req }) => ({
    verify: getProductionVerifier(),
    adminIdToken: bearer(req.headers.authorization),
  }),
});

const allowedOrigins = (
  process.env.ALLOWED_WS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: (info, cb) => {
    const origin = info.origin;
    // No Origin = non-browser client (allowed). Browser origins must be allowlisted.
    if (!origin || allowedOrigins.includes(origin)) cb(true);
    else cb(false, 403, 'Forbidden origin');
  },
});
applyWSSHandler({
  wss,
  router: appRouter,
  createContext: () => ({ verify: getProductionVerifier() }),
});

httpServer.listen(API_PORT);
console.log(`[discreetly:api] tRPC on http://localhost:${API_PORT}`);
console.log(`[discreetly:api] tRPC/WS on ws://localhost:${API_PORT}`);
