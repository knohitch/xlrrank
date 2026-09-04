# AI Gateway

Laws 2, 7, 9. Decision: see ADR-0003.

## Positioning

The AI gateway (`@xlrrank/ai-core`) is a provider-neutral layer. Core application code never
invokes a vendor SDK directly — only provider adapters do. Adapters exist for OpenAI, Anthropic,
DeepSeek, xAI/Grok, Xiaomi MiMo, a generic OpenAI-compatible provider, and a local
Ollama/local-compatible implementation.

## Contract-first calls

Every AI capability is expressed as a **JSON Schema contract** validated at the boundary:

- `text generation`
- `reasoning`
- `structured output` (schema-constrained)
- `tool calling`
- `vision`
- `embeddings`
- `streaming`

Callers declare an expected output schema. The gateway renders the task for the chosen provider,
calls through the adapter, and validates the provider output against the schema **before** delivery.
Schema failures are observable and treated as provider health signals (see observability phase).

## Pipeline responsibilities owned by the gateway

- Model discovery and registry (models are discovered/probed/benchmarked, never hardcoded).
- Routing across reasoning tiers by capability, benchmark quality, cost, latency, provider health,
  context window, language compliance, and structured-output reliability, with
  `AUTOMATIC` / `QUALITY_OPTIMIZED` / `COST_OPTIMIZED` / `CUSTOM` modes and fallback.
- Language guard: provider-independent output language enforcement between generation and delivery
  (see below).
- Usage and cost metering, budgets, BYOK.

## Language guard

Between the model and the user a language guard runs: schema validation → language detection →
script analysis → policy validation → repair (preserving numbers, URLs, IDs, usernames, code,
citations) → revalidation → delivery. If output violates the configured language after configured
attempts, the gateway uses a configured fallback model or returns a controlled error. The guard
distinguishes Chinese from Japanese rather than blocking all CJK characters. Configuration is
deployable-per-installation; the canonical default is English. The guard applies to
system-generated presentation/explanation output only — raw imported source content is never
rewritten.

## Honesty guarantees

Providers that lack a capability (vision, embeddings, …) report it; the router never pretends
availability. When credentials/permissions are absent the gateway surfaces
`CONFIGURATION_REQUIRED` / `PERMISSION_REQUIRED` / `APP_REVIEW_REQUIRED` / `UNAVAILABLE` — never
fabricated model output.