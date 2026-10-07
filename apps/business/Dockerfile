# syntax=docker/dockerfile:1

# Polaris for Business in production: one long-lived Node process with a
# persistent disk for the SQLite store (the relayer's nonce lanes and the
# chain sync live in this process too, so run exactly one).
#
# Build from the repository root; the context is the whole workspace:
#
#   docker build -f apps/business/Dockerfile -t polaris-business .
#   docker run --rm -p 3100:3100 -v polaris-data:/data --env-file apps/business/.env.production polaris-business
#
# Browser-side settings (NEXT_PUBLIC_*) are compiled into the bundle, so they
# are build arguments: pass them with --build-arg (or [build.args] in
# fly.toml). Everything else, secrets included, is runtime environment.
# docs/deploy.md has the full list and the Fly and Railway steps.

ARG NODE_VERSION=22.21.1

# ── base: Node and the repository's pnpm ─────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
WORKDIR /repo

# ── manifests: every package.json and the lockfile, nothing else ─────────────
# The install layer below is rebuilt only when one of these changes.
FROM base AS manifests
COPY . .
RUN find . -type f \
      ! -name package.json ! -name pnpm-lock.yaml ! -name pnpm-workspace.yaml ! -name .npmrc \
      -delete \
 && find . -type d -empty -delete

# ── deps: the pruned workspace (Polaris for Business and what it imports) ────
FROM base AS deps
COPY --from=manifests /repo ./
RUN pnpm install --frozen-lockfile --filter "@polaris/business..."

# ── build: next build, standalone output ─────────────────────────────────────
FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_PRIVY_APP_ID=""
ARG NEXT_PUBLIC_PRIVY_CLIENT_ID=""
ARG NEXT_PUBLIC_PRIVY_PAYOUT_SIGNER_ID=""
ARG NEXT_PUBLIC_MONAD_TESTNET_RPC=""
ARG NEXT_PUBLIC_DEMO_SHOP_URL=""
ARG NEXT_PUBLIC_AUSD_ADDRESS=""
ARG NEXT_PUBLIC_AUSD_EIP712_NAME="Agora Dollar"
ARG NEXT_PUBLIC_AUSD_EIP712_VERSION="1"
ENV NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID \
    NEXT_PUBLIC_PRIVY_CLIENT_ID=$NEXT_PUBLIC_PRIVY_CLIENT_ID \
    NEXT_PUBLIC_PRIVY_PAYOUT_SIGNER_ID=$NEXT_PUBLIC_PRIVY_PAYOUT_SIGNER_ID \
    NEXT_PUBLIC_MONAD_TESTNET_RPC=$NEXT_PUBLIC_MONAD_TESTNET_RPC \
    NEXT_PUBLIC_DEMO_SHOP_URL=$NEXT_PUBLIC_DEMO_SHOP_URL \
    NEXT_PUBLIC_AUSD_ADDRESS=$NEXT_PUBLIC_AUSD_ADDRESS \
    NEXT_PUBLIC_AUSD_EIP712_NAME=$NEXT_PUBLIC_AUSD_EIP712_NAME \
    NEXT_PUBLIC_AUSD_EIP712_VERSION=$NEXT_PUBLIC_AUSD_EIP712_VERSION \
    POLARIS_NEXT_OUTPUT=standalone
# next build (it builds @polarispay/underwriting first), then gather what the
# server reads from disk at runtime rather than from its bundle: the
# deployment records (src/server/env.ts) and the CRE workflows' schedules
# (src/server/cre/overview.ts), kept at the same paths relative to
# apps/business.
RUN pnpm --filter @polaris/business build \
 && mkdir -p /extras/packages/contracts/deployments \
 && for f in monad-testnet.json monad.json; do \
      if [ -f "packages/contracts/deployments/$f" ]; then cp "packages/contracts/deployments/$f" /extras/packages/contracts/deployments/; fi; \
    done \
 && for w in collections underwriting guardian; do \
      mkdir -p "/extras/workflows/$w" && cp "workflows/$w/config.staging.json" "workflows/$w/config.production.json" "/extras/workflows/$w/"; \
    done

# ── runtime: the standalone server, no toolchain, no dev dependencies ────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3100 \
    HOSTNAME=0.0.0.0 \
    POLARIS_DATA_DIR=/data \
    POLARIS_DB_URL=sqlite:/data/polaris.db \
    POLARIS_WORKERS=1 \
    POLARIS_DEPLOYMENT=monad-testnet
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/business/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/business/.next/static ./apps/business/.next/static
COPY --from=build --chown=node:node /repo/apps/business/public ./apps/business/public
COPY --from=build --chown=node:node /extras/ ./
COPY --chmod=755 apps/business/docker/entrypoint.sh /usr/local/bin/polaris-entrypoint
# The store lives in /data: mount a volume there (no VOLUME instruction,
# which Railway refuses; Fly and `docker run -v` mount it without one).
RUN mkdir -p /data && chown node:node /data
EXPOSE 3100
# Readiness: the store opens and its volume is writable, a chain is
# configured, and the background loops are running (src/server/readiness.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3100) + '/api/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# The entrypoint makes the mounted volume the node user's, then runs the
# server as that user (never as root).
ENTRYPOINT ["polaris-entrypoint"]
CMD ["node", "apps/business/server.js"]
