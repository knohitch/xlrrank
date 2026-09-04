# ADR-0003 — Provider-neutral AI gateway with JSON Schema contracts

Status: Accepted.

## Context

The AI/router subsystem is large and the pack forbids core dependence on any vendor. Models must
be discoverable and interchangeable without rewriting business logic, and the language guard must
be provider-independent.

## Decision

- All AI capability calls express their output as a **JSON Schema contract**; the gateway
  validates provider output against the contract before delivery.
- Provider adapters (OpenAI, Anthropic, DeepSeek, xAI/Grok, Xiaomi MiMo, generic
  OpenAI-compatible, local/Ollama) are the only place vendor SDKs are imported.
- The gateway owns model registry (discovery/probe/benchmark lifecycle), routing by reasoning
  tier with fallback, the language guard, usage/cost metering, budgets, and BYOK.
- Deterministic scoring stays out of AI entirely (see Law 9).

## Consequences

- Adding a provider means writing an adapter plus a capability contract — no business-logic
  changes.
- Contract validation failures double as provider health signals.
- The language guard runs in one place, between the model and the user.