# XLRrank Architecture

## The Project Constitution

Start with [constitution.md](constitution.md). It is the source of truth for every phase of this
build. Every phase must pass `pnpm lint:constitution`.

## Documents

| Document | Laws | Covers |
| --- | --- | --- |
| [constitution.md](constitution.md) | all | Product definition, required applications, invariants |
| [entities.md](entities.md) | Law 1 | Platform-agnostic core domain entities |
| [evidence-and-provenance.md](evidence-and-provenance.md) | Laws 4, 5 | Evidence source kinds, provenance, explainability |
| [connectors.md](connectors.md) | Laws 6, 7 | Capability-driven connectors, availability states |
| [events.md](events.md) | Law 8 | Event-driven processing and workers |
| [intelligence-and-scoring.md](intelligence-and-scoring.md) | Law 9 | AI vs deterministic logic, reasoning tiers, scoring |
| [ai-gateway.md](ai-gateway.md) | Laws 2, 7, 9 | Provider-neutral gateway and JSON Schema contracts |
| [testing.md](testing.md) | Law 10 | Test strategy across all layers |

## Decision Records

See [decisions/](../decisions/README.md) for Architecture Decision Records capturing material
choices made in this phase.