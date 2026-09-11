# Sprint 10 Local Verification

Date: 2026-09-10
Branch: `audit/production-verification-2026-09-04`

## Scope

Sprint 10 hardened the AI provider runtime and replaced the memory-only model registry with a persistent, provider-neutral registry backed by PostgreSQL.

## Evidence

- Provider/runtime configuration is data-driven through `ai_providers.protocol`, base URL/config, and protocol adapters for OpenAI-compatible, Anthropic, xAI, and Ollama-style discovery.
- Credentials are separated into `ai_provider_credentials`, encrypted with AAD context binding, and resolved server-side. Safe DTOs do not return credential material.
- Model discovery persists canonical models in `ai_models`; availability/provenance is tracked per runtime credential in `ai_model_availability`.
- Capability probes persist per-capability validation in `ai_model_capability_validations`; text-only and embedding-only models validate without requiring structured output or streaming.
- Lifecycle does not auto-promote discovered models to `ACTIVE`; successful probes move models to `VALIDATED`.
- Discovery failures record safe health evidence and preserve existing model registry state.
- Durable refresh jobs use the existing `jobs` + `job_outbox` path with ID-only payloads and a model-management worker processor.
- Custom base URL validation fails closed for private/local network URLs unless trusted configuration explicitly allows them.

## Focused Tests

- `pnpm --filter @xlrrank/ai-core test`: 2/2 passed.
  - OpenAI-compatible fixture: dynamic model list, scoped BYOK isolation, auth failure, new model discovery, fingerprint revalidation, provider list failure preservation, text-only validation, embedding-only validation, failed structured capability, bounded discovery/probe work, durable payload hygiene, SSRF policy.
  - Anthropic/Ollama fixture: paginated Anthropic discovery, dynamic IDs, Ollama tag discovery, no static Anthropic production catalog.
- `pnpm --filter @xlrrank/config test`: 10/10 passed, including AI discovery/probe maximum bounds.

## Gates

- `REMOTE CI: BLOCKED_INFRA`
- `WORKER DOCKER RUNTIME: BLOCKED_LOCAL_INFRA`
- `AI LIVE PROVIDER GATE: BLOCKED_EXTERNAL`

No live AI provider credentials were supplied or tested.
