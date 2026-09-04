# Event-Driven Processing

Law 8. Reference implementation: `packages/shared/src/constitution/events.ts`.

## Domain events

Important system events are published as domain events and consumed by independent workers:

- `CONTENT_INGESTED`
- `PERSON_DISCOVERED`
- `INTERACTION_INGESTED`
- `RELATIONSHIP_UPDATED`
- `MODEL_DISCOVERED`
- `MODEL_UPDATED`
- `OPPORTUNITY_DISCOVERED`

## What workers may do independently

Bytes-lived effects are decoupled from ingestion:

- embeddings and vector index updates;
- classification and topic extraction;
- Social DNA updates;
- relationship and relationship-event updates;
- opportunity detection;
- trend calculations;
- analytics and reporting materialization.

## Rules

1. Event payloads are idempotent-friendly; consumers tolerate reprocessing.
2. Large synchronous ingestion never blocks HTTP request handling; it is enqueued.
3. Worker failures are observable and retryable (see observability phase).