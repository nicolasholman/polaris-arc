FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
COPY . .
RUN pnpm install --frozen-lockfile --filter "@polaris/app..."
ARG NEXT_PUBLIC_POLARIS_API_URL
ARG NEXT_PUBLIC_RP_ID
ENV NEXT_PUBLIC_POLARIS_API_URL=$NEXT_PUBLIC_POLARIS_API_URL NEXT_PUBLIC_RP_ID=$NEXT_PUBLIC_RP_ID NEXT_PUBLIC_CHAIN_ID=5042002 NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @polaris/app build
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /repo/apps/app/.next/standalone ./
COPY --from=build /repo/apps/app/.next/static ./apps/app/.next/static
COPY --from=build /repo/apps/app/public ./apps/app/public
USER node
CMD ["node", "apps/app/server.js"]
