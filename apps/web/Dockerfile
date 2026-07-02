# syntax=docker/dockerfile:1
#
# Production image for @discreetly/web (Next.js standalone).
#
# The @ministryofmany/* SDK deps are `link:../../../minister-client/...` — a
# SIBLING checkout outside this repo — so the build needs a second, named
# context supplying it. Built from the monorepo root:
#   docker buildx build -f apps/web/Dockerfile \
#     --build-context minister-client=../minister-client \
#     --build-arg NEXT_PUBLIC_API_URL=http://localhost:3002 \
#     --build-arg NEXT_PUBLIC_API_WS_URL=ws://localhost:3002 \
#     -t discreetly-web .
# (compose: build.additional_contexts — see infra/docker-compose.prod.yml)
#
# NEXT_PUBLIC_* are inlined into the client bundle at BUILD time, so they must be
# passed as build args (a new image is required to change them). MINISTER_*,
# AUTH_*, and the server-side env are read at runtime.

# ---- builder ----
# node:20-bookworm-slim
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder
WORKDIR /app

# Prisma client generation (a workspace postinstall) needs OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY . .

# The sibling SDK checkout lands at /minister-client, which is exactly where
# the relative `link:` targets resolve from /app/apps/web (../../../). pnpm does
# not install a link: target's own dependencies, so install the SDK workspace
# here — webpack needs both its runtime imports (jose, zod, …) and the built
# dist/ the link: packages' exports point at. That dist/ is gitignored in
# minister-client (rebuildable output, not committed) with no prepare script, so
# build the @ministryofmany/* libs explicitly after install.
COPY --from=minister-client . /minister-client
RUN cd /minister-client && pnpm install --frozen-lockfile \
  && pnpm --filter "@ministryofmany/*" run build

RUN pnpm install --frozen-lockfile

# NEXT_PUBLIC_* are compiled into the bundle. Defaults match the local prod ports.
ARG NEXT_PUBLIC_API_URL=http://localhost:3002
ARG NEXT_PUBLIC_API_WS_URL=ws://localhost:3002
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_API_WS_URL=${NEXT_PUBLIC_API_WS_URL}
ENV NEXT_TELEMETRY_DISABLED=1

# `prebuild` copies the RLN circuit artifacts into public/circuits/rln/, then
# `next build` emits .next/standalone (output: 'standalone').
RUN pnpm --filter @discreetly/web build

# ---- runner ----
# node:20-bookworm-slim
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

# Run as a non-root user.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone server bundle. With outputFileTracingRoot = monorepo root the
# traced layout is rooted at /app: server entry is apps/web/server.js and it
# carries its own node_modules (incl. the traced workspace packages).
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
# Static assets and circuit artifacts are not traced into standalone; copy them
# into the expected locations under the app directory.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3001

CMD ["node", "apps/web/server.js"]
