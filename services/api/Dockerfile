# syntax=docker/dockerfile:1
#
# Production image for @discreetly/api. The API has no build step: it runs the
# TypeScript source directly via tsx. The runtime therefore keeps the workspace
# TS source, tsx, and the generated Prisma client.
#
# The @ministryofmany/* SDK deps are `link:../../../minister-client/...` — a
# SIBLING checkout outside this repo — so the build needs a second, named
# context supplying it. Built from the monorepo root:
#   docker buildx build -f services/api/Dockerfile \
#     --build-context minister-client=../minister-client -t discreetly-api .
# (compose: build.additional_contexts — see infra/docker-compose.prod.yml)

# ---- deps: install the full workspace and generate the Prisma client ----
# node:20-bookworm-slim
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS deps
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

# The sibling SDK checkout lands at /minister-client, which is exactly where
# the relative `link:` targets resolve from /app/services/api (../../../).
COPY --from=minister-client . /minister-client

# pnpm does not install a `link:` target's own dependencies, so install the SDK
# workspace here: the link: packages need both their runtime deps (jose, zod, …)
# and the built dist/ their exports point at. That dist/ is gitignored in
# minister-client (rebuildable output, not committed) with no prepare script, so
# build the @ministryofmany/* libs explicitly after install.
RUN cd /minister-client && pnpm install --frozen-lockfile \
  && pnpm --filter "@ministryofmany/*" run build

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @discreetly/db generate

# ---- runner ----
# node:20-bookworm-slim
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runner
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
# client) and the source tree that tsx executes, plus the linked SDK checkout
# the link: symlinks point into.
COPY --from=deps --chown=node:node /app /app
COPY --from=deps --chown=node:node /minister-client /minister-client

USER node

EXPOSE 3002

# Liveness probe (node fetch; the slim image has no curl). /health is a cheap
# process-up check that bypasses rate limiting and CORS.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx runs src/server.ts (see services/api/package.json `start`).
CMD ["pnpm", "--filter", "@discreetly/api", "start"]
