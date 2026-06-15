import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { WebSocketServer } from 'ws';
import { appRouter } from './trpc/app.router.js';
import { getProductionVerifier } from './minister/production-verifier.js';
import { getConfig } from './config.js';

const { API_PORT } = getConfig();

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
  createContext: () => ({ verify: getProductionVerifier() }),
});

const wss = new WebSocketServer({ server: httpServer });
applyWSSHandler({ wss, router: appRouter, createContext: () => ({ verify: getProductionVerifier() }) });

httpServer.listen(API_PORT);
console.log(`[discreetly:api] tRPC on http://localhost:${API_PORT}`);
console.log(`[discreetly:api] tRPC/WS on ws://localhost:${API_PORT}`);
