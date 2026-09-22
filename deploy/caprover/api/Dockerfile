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
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/api/health/ready').then(async r=>{const j=await r.json().catch(()=>({}));process.exit(r.ok&&j.status==='ready'?0:1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]
