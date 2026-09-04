# ADR-0004 — Constitution encoded in shared types and a repository guard

Status: Accepted.

## Context

The constitution consists of laws that are easy to violate silently (platform-specific core
entities, hardcoded model names, committed secrets) and hard to notice in review.

## Decision

- Encode the constitution in **shared TypeScript types** under
  `packages/shared/src/constitution`: core entities (Law 1), evidence/provenance (Laws 4–5),
  capabilities/availability (Laws 6–7), domain events (Law 8), reasoning tiers and scoring
  contracts (Law 9).
- Add a **repository guard** (`scripts/constitution-guard.mjs`, run via `pnpm lint:constitution`)
  that mechanically rejects forbidden platform-specific identifiers, secret literals, and
  hardcoded model names outside the AI/config packages.
- Guard behavior is itself covered by automated tests (`pnpm test:constitution`).

## Consequences

- The laws are measurable, not just prose.
- The guard is intentionally conservative; exceptions (e.g. model names inside the AI adapter
  package) are explicit.
- Future phases reference these types instead of redefining contract vocabulary.