# XLRrank Project Constitution

Status: Ratified — Prompt 0.

This constitution governs every subsequent phase of the build. New prompts extend feature work;
they do not change the laws without a new architecture decision. The constitution is enforced in
two ways:

1. **Documentation** — the laws below, plus the subsystem documents in this directory.
2. **Code and tooling** — shared types in `@xlrrank/shared/src/constitution` and the repository
   guard (`pnpm lint:constitution`) that mechanically catches the most dangerous violations.

## 1. Product

XLRrank is a platform-agnostic social, audience, relationship, content, and network intelligence
platform. It connects to multiple social platforms and AI providers and understands:

- people, social accounts, organizations, communities;
- posts, conversations, interactions, relationships;
- audiences, interests, expertise, content, topics, trends;
- opportunities, commercial intent, network movement, relationship history.

XLRrank tells a user:

- who they should know and why they matter;
- which conversations are worth entering and which should be ignored;
- which topics are emerging and what their network is discussing;
- which relationships are warming, cooling, or need attention;
- which commercial opportunities, content gaps, and actions deserve attention today.

Actual social actions remain human-controlled unless an official platform API explicitly permits an
action and the product deliberately supports it. Mass-following, mass-liking, spam, vote
manipulation, unauthorized mass messaging, and prohibited automation are never implemented.

## 2. Required applications

The repository is a pnpm workspace monorepo:

```
apps/
  web/          Next.js + React web UI
  api/          structured TypeScript API (NestJS-style structure)
  worker/       background job workers
  extension/    React + TypeScript Manifest V3 browser extension
packages/
  database/     PostgreSQL schema, migrations, repositories
  auth/         authentication and authorization
  ui/           shared UI primitives
  config/       shared configuration and lint/format presets
  shared/       constitution types and cross-cutting contracts
  social-core/  platform-neutral social domain logic
  ai-core/      provider-neutral AI gateway, model registry, routing
  intelligence/ intelligence engines
  observability/ logging, metrics, tracing, error tracking
  plugin-sdk/   plugin and connector SDK
  testing/      test utilities and fixtures
infra/          Docker Compose and deployment definitions
docs/           architecture, decisions, operations
```

TypeScript is used throughout unless another language is objectively necessary for a specific
subsystem.

### Preferred stack

- Next.js + React for the web UI
- Backend API in structured TypeScript (NestJS-style)
- PostgreSQL with pgvector
- Redis
- Background job queues
- S3-compatible object storage abstraction (filesystem adapter for local development)
- React + TypeScript Manifest V3 browser extension
- Docker Compose for canonical self-hosting

### Local development without Docker

Docker is the canonical self-hosting path (Compose launcheds web, api, worker, postgres,
redis). On machines without Docker, the same Postgres/Redis contract is provided by a local
fallback so development remains runnable. See ADR-0002. Production data paths are
Postgres/pgvector-native and never depend on the fallback.

## 3. Architectural laws

### Law 1 — Nothing platform-specific in the core

Core concepts never use platform-specific entities. Use `Person`, `SocialAccount`, `Platform`,
`Content`, `Interaction`, `Organization`, `Community`, `Relationship`, `Topic`, `Opportunity`.
Identifiers such as one platform slug joined with `_user`/`_person`/`_contact` are forbidden in
code. Platform-specific behavior belongs in connectors.

Enforced by: `packages/shared/src/constitution/entities.ts` and the repository guard.

### Law 2 — Providers are adapters

Provider abstractions exist for: social platforms, AI providers, embedding providers, auth
providers where appropriate, email, object storage, billing, and queues where appropriate. Core
business logic never depends directly on a commercial vendor. Only adapters import vendor SDKs.

### Law 3 — Open-source ready

Assume the repository may be published tomorrow. No embedded keys, secrets, mandatory proprietary
cloud, hardcoded domain, hardcoded platform IDs, model names in business logic, subscription plans
in business logic, scoring weights, relationship pipelines, or deployment vendor. Provide
`.env.example`. Self-hosting must be possible. No secrets committed to Git.

Enforced by: the repository guard (secret literals, hardcoded model names outside `ai-core`/`config`).

### Law 4 — Raw data, facts and AI inference are different

Every significant piece of intelligence distinguishes `OBSERVED`, `USER_PROVIDED`, `DERIVED`, and
`INFERRED`. Example: follower count from an API is `OBSERVED`; "likely fintech investor" from AI is
`INFERRED`. These are never mixed internally.

### Law 5 — Provenance

Important recommendations remain explainable. Store what evidence created a result, which scoring
version, which AI model, which prompt version, which source objects, and when. See
[evidence-and-provenance.md](evidence-and-provenance.md).

### Law 6 — Capability-driven connectors

A connector reports its abilities (e.g. `profiles`, `content`, `comments`, `search`, `metrics`,
`followers`, `following`, `audience_insights`, `messages`, `publishing`). The application checks
capabilities; it never assumes every platform supports the same features.

### Law 7 — No fake success

If a platform cannot provide a requested capability because credentials or permissions are
unavailable, return an explicit unavailable state (`CONFIGURATION_REQUIRED`, `PERMISSION_REQUIRED`,
`APP_REVIEW_REQUIRED`, `UNAVAILABLE`). Never return invented live platform data. Never silently
scrape in place of an unavailable official API feature.

### Law 8 — Event-driven processing

Important system events feed independent workers: `CONTENT_INGESTED`, `PERSON_DISCOVERED`,
`INTERACTION_INGESTED`, `RELATIONSHIP_UPDATED`, `MODEL_DISCOVERED`, `MODEL_UPDATED`,
`OPPORTUNITY_DISCOVERED`. Workers independently perform embeddings, classification, topic
extraction, Social DNA updates, relationship updates, opportunity detection, trend calculations,
and analytics. See [events.md](events.md).

### Law 9 — AI is not the business logic

AI must not invent deterministic numerical scores. Deterministic operations use structured data,
mathematics, graph algorithms, configured scoring rules, and statistical analysis. LLMs are used
for interpretation, classification, reasoning, language generation, semantic extraction, and
explanations — always grounded in stored evidence. See
[intelligence-and-scoring.md](intelligence-and-scoring.md) and [ai-gateway.md](ai-gateway.md).

### Law 10 — Test everything

Unit, integration, API, authorization, connector, AI provider, worker, database, extension, and
end-to-end tests. External API calls use deterministic test fixtures, but production connectors
contain genuine implementations.

## 4. Development rules

- Never destroy, replace, or regress working functionality.
- Never fake integrations or claim placeholders are functional.
- Every phase runs relevant tests, type checks, builds, migrations, and linting, and fixes
  failures before finishing.
- Every phase updates documentation.
- The next numbered phase does not begin until instructed.

## 5. Completion

The product is complete only when the full architecture described in this pack is built, tested,
documented, and self-hosting; demo data is added only near the end and clearly identified as demo.
The platform's real intellectual property is Social DNA, discovery, network/relationship/
opportunity/trend/content intelligence, identity resolution, scoring, routing, provenance, and
cross-platform knowledge.