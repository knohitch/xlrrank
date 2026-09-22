ARG BASE_IMAGE=node:22-alpine
FROM ${BASE_IMAGE} AS base

RUN corepack enable
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY turbo.json ./

FROM base AS deps
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 CMD node apps/worker/dist/main.js --readiness-check
CMD ["node", "apps/worker/dist/main.js"]
