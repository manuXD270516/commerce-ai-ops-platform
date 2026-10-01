# syntax=docker/dockerfile:1
# One build for the monorepo, one runtime target per app (api, worker, mcp, web, migrate).
# Images are immutable: tag them with the git commit; configuration and secrets come from the
# environment (*_FILE variables point at mounted secret files).
ARG NODE_IMAGE=node:22.23.1-bookworm

FROM ${NODE_IMAGE} AS build
ENV CI=true NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build \
 && pnpm install --frozen-lockfile --prod --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
COPY --chmod=0755 infra/docker/entrypoint.sh /usr/local/bin/entrypoint
USER node
ENTRYPOINT ["/usr/local/bin/entrypoint"]

FROM runtime AS api
WORKDIR /repo/apps/api
EXPOSE 3001
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]

FROM runtime AS worker
WORKDIR /repo/apps/worker
EXPOSE 3002
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]

FROM runtime AS mcp
WORKDIR /repo/apps/commerce-mcp-server
EXPOSE 3003
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]

FROM runtime AS web
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3000", "--hostname", "0.0.0.0"]

# One-shot job: forward-only migrations with the migrator role, then the synthetic demo seed only
# into an empty database (re-running the job never resets existing data).
FROM runtime AS migrate
WORKDIR /repo/packages/domain
CMD ["sh", "-c", "node dist/cli.js migrate && node dist/cli.js seed --if-empty"]
