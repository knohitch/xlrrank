# XLRrank Deployment

This guide covers the production packaging path for Coolify and CapRover. Do not commit real secrets. Configure secret values in the platform environment-variable UI.

## Environment

Required to boot:

- `NODE_ENV`
- `NEXT_PUBLIC_APP_URL`
- `API_PUBLIC_URL`
- `CORS_ORIGIN`
- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `REDIS_URL`
- `QUEUE_URL`
- `SESSION_SIGNING_SECRET`
- `ENCRYPTION_MASTER_KEY`
- `AI_ROUTING_POLICY_JSON`
- `STORAGE_DRIVER`
- `STORAGE_LOCAL_PATH`
- `EMAIL_TRANSPORT`

Optional features:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `XAI_API_KEY`
- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `META_CLIENT_ID`
- `META_CLIENT_SECRET`
- `LINKEDIN_CLIENT_ID`
- `LINKEDIN_CLIENT_SECRET`
- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`

Use `EMAIL_TRANSPORT=console` for a bootable base deployment without SMTP. Configure `EMAIL_TRANSPORT=smtp` plus SMTP settings before relying on email verification, password recovery, or transactional email.

`AI_ROUTING_POLICY_JSON` is required in production, but it does not contain provider credentials. A provider-neutral boot value is `{}`.

Use `STORAGE_DRIVER=filesystem` and `STORAGE_LOCAL_PATH=/app/storage` for a single-server deployment. Horizontally scaled production deployments should use the existing S3-compatible storage configuration instead of assuming a shared local filesystem.

## COOLIFY

Canonical Compose file: `docker-compose.yml`

Public services:

- `web`, port `3000`
- `api`, port `4000`

Private services:

- `worker`
- `postgres`
- `redis`
- `migrate`

Minimum setup sequence:

1. Create a Coolify Docker Compose resource from this repository on `master`.
2. Use `docker-compose.yml` as the Compose file.
3. Configure the required boot environment variables in Coolify.
4. Set `DATABASE_URL` to the internal Postgres service, for example `postgres://xlrrank:<POSTGRES_PASSWORD>@postgres:5432/xlrrank`.
5. Set `REDIS_URL=redis://redis:6379` and `QUEUE_URL=redis://redis:6379` unless using an external Redis service.
6. Mount the named volumes from the Compose file.
7. Deploy the stack.

Startup order is enforced by Compose:

`postgres` healthy -> `migrate` completes successfully -> `api` and `worker` start -> `web` starts after `api` is healthy.

PostgreSQL, Redis, and filesystem storage use persistent named volumes. Do not publish Postgres or Redis ports publicly.

## CAPROVER

Create three CapRover apps:

- `xlrrank-web`, public, container HTTP port `3000`
- `xlrrank-api`, public, container HTTP port `4000`
- `xlrrank-worker`, private / no public domain

Use internal PostgreSQL with pgvector and Redis services in CapRover, or connect equivalent private managed services. Do not expose PostgreSQL or Redis publicly.

Captain Definition Path to enter in CapRover for each app:

- API:
  - Captain Definition Path: `./captain-definition-api`
  - Container HTTP port: `4000`
- WEB:
  - Captain Definition Path: `./captain-definition-web`
  - Container HTTP port: `3000`
- WORKER:
  - Captain Definition Path: `./captain-definition-worker`
  - Container HTTP port: private / no public domain

Each definition points at the matching Dockerfile under `./deploy/caprover/<service>/Dockerfile`. Deploy each app from the repository root so the Docker build context includes the monorepo.

Configure the required boot environment variables on each app that runs server code. The web app needs `NODE_ENV`, `NEXT_PUBLIC_APP_URL`, and `API_PUBLIC_URL`; use the internal API URL for server-side proxying when available. The API and worker need the full required boot environment list above.

Safest first-deployment migration procedure:

1. Start private Postgres and Redis.
2. Deploy `xlrrank-api` with the required environment variables, but do not route user traffic yet.
3. Run one manual command in the API container: `node packages/database/dist/run-migrate.js`.
4. Confirm the command exits successfully.
5. Deploy/start `xlrrank-worker`.
6. Enable public routes for `xlrrank-api` and `xlrrank-web`.

Run migrations from one place only. Do not run migrations concurrently from API and worker containers.
