# XLRrank

Platform-agnostic social, audience, relationship, content, and network intelligence platform.

XLRrank connects to multiple social platforms and AI providers, and turns raw social observations into
explainable intelligence: who to know, why they matter, which conversations are worth entering, which
relationships are warming or cooling, what is emerging, and what deserves action today.

## Requirements

- Node.js >= 20.19.0
- pnpm >= 9 (via corepack)
- Docker (for the canonical self-hosted stack)

## Quick start

```bash
# 1. Install dependencies
pnpm install

# 2. Copy and edit environment
cp .env.example .env

# 3. Start infrastructure (PostgreSQL + Redis) with Docker
docker compose up -d postgres redis

# 4. Run database migrations
pnpm db:migrate

# 5. Start in development
pnpm dev
```

Then open:

- Web: http://localhost:3000
- API: http://localhost:4000/health
- API readiness: http://localhost:4000/health/ready

## Full Docker Compose (web + api + worker + postgres + redis)

```bash
docker compose up --build
```

## Commands

| Command | Description |
| --- | --- |
| `pnpm install` | Install all workspace dependencies |
| `pnpm dev` | Run all apps in development mode |
| `pnpm build` | Build all apps and packages |
| `pnpm test` | Run all workspace tests |
| `pnpm lint` | Lint all workspace packages |
| `pnpm lint:constitution` | Enforce the project constitution |
| `pnpm typecheck` | Type-check all workspace packages |
| `pnpm db:migrate` | Run database migrations |
| `pnpm db:seed` | Seed the database |
| `pnpm format` | Format all source files with Prettier |
| `pnpm clean` | Remove build output |

## Repository layout

```
apps/
  web/          Next.js + React web application
  api/          NestJS-style TypeScript API
  worker/       background job workers
  extension/    Manifest V3 browser extension (Chrome/Edge)
packages/
  database/     PostgreSQL schema, migrations, repositories (Drizzle ORM, pgvector)
  auth/         authentication and authorization
  ui/           shared UI primitives
  config/       environment validation
  shared/       constitution types and shared contracts
  queue/        Redis + BullMQ queue infrastructure
  storage/      S3-compatible / local filesystem storage abstraction
  social-core/  platform-neutral social domain logic
  ai-core/      provider-neutral AI gateway
  intelligence/ intelligence engines (DNA, discovery, relationships, opportunities, trends, content)
  observability/ structured logging, metrics
  plugin-sdk/   public plugin/connector SDK
  testing/      test utilities and fixtures
infra/          Dockerfile and deployment definitions
docs/           architecture, decisions, operations
```

## Environment variables

See [.env.example](.env.example) for the full list and descriptions.

## Documentation

Start with [docs/architecture/README.md](docs/architecture/README.md).
