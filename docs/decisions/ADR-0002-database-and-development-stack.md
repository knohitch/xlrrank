# ADR-0002 — Database stack and Docker-less local development

Status: Accepted.

## Context

The preferred stack requires PostgreSQL + pgvector, Redis, and a queue. The production
architecture must be canonical Docker Compose (self-hosting). The current development machine has
no Docker runtime and no locally installed Postgres/Redis.

## Decision

- **Canonical path**: Docker Compose launches `web`, `api`, `worker`, `postgres`, `redis` from
  committed Dockerfiles. Production data paths are Postgres/pgvector-native.
- **Local fallback**: when Docker is unavailable, a local-development stack stands in behind the
  same connection contracts (database URL, queue URL, storage interface). This keeps development
  runnable without Docker while never changing production semantics.
- Storage is always accessed through an S3-compatible abstraction; local development uses the
  filesystem adapter.

## Consequences

- One database/queue contract for both paths; code does not branch on the provider for logic.
- The fallback is an engineering convenience, not a supported production deployment.
- CI/acceptance for Compose and migrations is still performed in later phases where a
  Postgres/pgvector runtime is available.