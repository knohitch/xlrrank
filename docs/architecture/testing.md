# Testing Strategy

Law 10.

## Layers

- **Unit tests** — pure logic: scoring math, evidence labels, connectors' data normalization,
  guard, routers, validators.
- **Integration tests** — packages with real neighbors but disposable infrastructure
  (Postgres/pgvector, Redis via local stack on this machine, filesystem storage adapter).
- **API tests** — the API surface: auth flows, RBAC, provisioned entitlements, error semantics.
- **Authorization tests** — the acceptance cases from Prompt 2 (protected routes, admin routes,
  role separation, expiry, revocation, reset, verification).
- **Connector tests** — deterministic fixtures for normalized outputs; genuine production
  implementations remain behind the same interface.
- **AI provider tests** — contract-schema tests per adapter with deterministic fixtures.
- **Worker tests** — event consumers process fixtures idempotently.
- **Database tests** — migrations run cleanly; pgvector operators behave.
- **Extension tests** — manifest validity, API client behavior, selector resilience.
- **End-to-end tests** — key user journeys through a running stack.

## Rules

1. External API fixtures are deterministic; no live external calls in unit/integration tests.
2. Production connectors contain real implementations — fixtures are for tests only.
3. Every phase runs the relevant test layers and linting before reporting completion.
4. The constitution guard (`pnpm lint:constitution`) is part of the default checks.