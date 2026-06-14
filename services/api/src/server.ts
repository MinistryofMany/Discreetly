import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { appRouter } from './trpc/app.router.js';
import { verifyMinisterIdToken } from './minister/verify.js';
import { config } from './config.js';

const server = createHTTPServer({
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
  createContext: () => ({ verify: verifyMinisterIdToken }),
});

server.listen(config.API_PORT);
console.log(`[discreetly:api] tRPC on http://localhost:${config.API_PORT}`);
