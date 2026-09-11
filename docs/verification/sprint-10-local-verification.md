# Sprint 10 Local Verification

Date: 2026-09-11
Branch: `audit/production-verification-2026-09-04`

## Scope

Sprint 10 hardened the AI provider runtime and replaced the memory-only model registry with a persistent, provider-neutral registry backed by PostgreSQL.

## Evidence

- Provider/runtime configuration is data-driven through `ai_providers.protocol`, base URL/config, and protocol adapters for OpenAI-compatible, Anthropic, xAI, and Ollama-style discovery.
- Credentials are separated into `ai_provider_credentials`, encrypted with AAD context binding, and resolved server-side. Safe DTOs do not return credential material.
- Model discovery persists canonical models in `ai_models`; availability/provenance is tracked per runtime credential in `ai_model_availability`.
- Capability probes persist per-capability validation in `ai_model_capability_validations`; text-only and embedding-only models validate without requiring structured output or streaming, and failed structured probes do not erase successful text validation.
- Lifecycle does not auto-promote discovered models to `ACTIVE`; successful probes move models to `VALIDATED`.
- Discovery failures record safe health evidence and preserve existing model registry state; successful missing-model discoveries use a bounded miss threshold before marking runtime availability `UNAVAILABLE`, and rediscovery restores `AVAILABLE`.
- Durable refresh jobs use the existing `jobs` + `job_outbox` path with ID-only payloads and a model-management worker processor that transitions the durable ledger through `RUNNING`, `COMPLETED`, or safe retry/failure states.
- Worker runtime schedules bounded AI registry refresh requests for enabled providers without a hardcoded provider list.
- Custom base URL and request-path validation fail closed for private/local/reserved DNS resolution unless trusted configuration explicitly allows private-network access. Redirects remain disabled.
- Registry persistence, probe persistence, and durable refresh request creation use checked-out PostgreSQL clients for transaction boundaries; rollback tests prove forced mid-transaction failures do not leave partial writes.
- Probe timeouts propagate abort signals through provider HTTP calls, including streaming-capable paths, so hanging provider requests are cancelled.

## Focused Tests

- `pnpm --filter @xlrrank/ai-core test`: 4/4 passed.
  - OpenAI-compatible fixture: real model-list shape without fake capability arrays, dynamic model list, scoped BYOK isolation, auth failure, new model discovery, fingerprint revalidation, provider list failure preservation, text-only validation, embedding-only validation, failed structured capability, availability disappearance grace, rediscovery, bounded discovery/probe work, durable payload hygiene, DNS SSRF policy, transaction rollback, and abortable probe timeout.
  - Anthropic/Ollama fixture: paginated Anthropic discovery with provider capability keys, dynamic IDs, Ollama tag discovery, and no static Anthropic production catalog.
- `pnpm --filter @xlrrank/config test`: 10/10 passed, including AI discovery/probe maximum bounds.
- `pnpm --filter @xlrrank/worker test -- sprint-10-ai-model-registry-worker.test.mjs`: 8/30 passed, 22 skipped, including durable AI registry processor completion/retry ledger states and bounded scheduled refresh orchestration.
- Broad local matrix:
  - `pnpm lint --concurrency=2`: passed with existing warnings only.
  - `pnpm typecheck --concurrency=2`: passed.
  - `pnpm build`: passed.
  - `pnpm test --concurrency=2`: passed.
  - `pnpm audit --prod`: passed, no known vulnerabilities.
  - `git diff --check`: passed with line-ending warnings only.

## Gates

- `REMOTE CI: BLOCKED_INFRA`
- `WORKER DOCKER RUNTIME: BLOCKED_LOCAL_INFRA`
- `AI LIVE PROVIDER GATE: BLOCKED_EXTERNAL`

No live AI provider credentials were supplied or tested.
