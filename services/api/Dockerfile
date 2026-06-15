# syntax=docker/dockerfile:1
#
# Production image for @discreetly/api. The API has no build step: it runs the
# TypeScript source directly via tsx. The runtime therefore keeps the workspace
# TS source, tsx, and the generated Prisma client. Built from the monorepo root:
#   docker build -f services/api/Dockerfile -t discreetly-api .

# ---- deps: install the full workspace and generate the Prisma client ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Prisma's query engine needs OpenSSL at generate and runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Copy the whole workspace (the .dockerignore strips node_modules / build output).
# The API depends on several workspace packages and runs from source, so a
# selective copy buys little and risks missing a transitive workspace file.
COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @discreetly/db generate

# ---- runner ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV API_PORT=3002

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Run as a non-root user. The node:20-bookworm-slim image ships a built-in
# `node` user (uid 1000 / gid 1000); use it directly.
RUN chown -R node:node /app

# Carry over the installed workspace (node_modules with the generated Prisma
# client) and the source tree that tsx executes.
COPY --from=deps --chown=node:node /app /app

USER node

EXPOSE 3002

# Liveness probe (node fetch; the slim image has no curl). /health is a cheap
# process-up check that bypasses rate limiting and CORS.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx runs src/server.ts (see services/api/package.json `start`).
CMD ["pnpm", "--filter", "@discreetly/api", "start"]
