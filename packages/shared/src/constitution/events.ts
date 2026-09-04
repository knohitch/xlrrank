/**
 * Architectural Law #8 — Event-driven processing.
 *
 * Important system events feed independent workers. Workers may perform
 * embeddings, classification, topic extraction, Social DNA updates,
 * relationship updates, opportunity detection, trend calculations, and
 * analytics independently.
 */

export const DOMAIN_EVENT_TYPES = [
  "CONTENT_INGESTED",
  "PERSON_DISCOVERED",
  "INTERACTION_INGESTED",
  "RELATIONSHIP_UPDATED",
  "MODEL_DISCOVERED",
  "MODEL_UPDATED",
  "OPPORTUNITY_DISCOVERED",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export interface DomainEvent<T = unknown> {
  type: DomainEventType;
  entityId: string;
  occurredAt: string;
  payload: T;
}