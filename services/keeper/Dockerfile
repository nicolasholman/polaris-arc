FROM node:24-bookworm-slim
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
COPY . .
RUN pnpm install --frozen-lockfile --filter "@polaris/keeper..."
ENV NODE_ENV=production POLARIS_DEPLOYMENT=arc-testnet KEEPER_HOST=0.0.0.0 KEEPER_PORT=2000
USER node
CMD ["pnpm", "--filter", "@polaris/keeper", "start"]
