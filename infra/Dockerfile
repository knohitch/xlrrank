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

# Build the real workspace graph instead of naming packages manually. This
# prevents Docker from drifting away from the monorepo as packages are added,
# removed, or renamed and fails the image build if any production workspace
# cannot compile.
FROM deps AS build
RUN pnpm build

FROM build AS api-build
FROM build AS web-build
FROM build AS worker-build

FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=api-build /app /app
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]

FROM node:22-alpine AS web
WORKDIR /app
ENV NODE_ENV=production
COPY --from=web-build /app /app
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "apps/web"]

FROM node:22-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=worker-build /app /app
CMD ["node", "apps/worker/dist/main.js"]
