/**
 * Architectural Law #1 — Nothing platform-specific in the core.
 *
 * Core concepts are platform-agnostic. Platform-specific behavior lives inside
 * connectors. Identifier suffixes must never be bound to a single platform:
 * for example a platform slug combined with a `_user`, `_person` or `_contact`
 * suffix is forbidden.
 *
 * A `Platform` is a discovery/config record, not an implementation.
 */

export const CORE_ENTITY_KINDS = [
  "PERSON",
  "SOCIAL_ACCOUNT",
  "PLATFORM",
  "CONTENT",
  "INTERACTION",
  "ORGANIZATION",
  "COMMUNITY",
  "RELATIONSHIP",
  "TOPIC",
  "OPPORTUNITY",
] as const;

export type CoreEntityKind = (typeof CORE_ENTITY_KINDS)[number];

export interface PlatformId {
  id: string;
}

export interface EntityId {
  id: string;
}

export interface Person extends EntityId {
  kind: "PERSON";
  name: string;
  bio?: string;
  location?: string;
  website?: string;
  accountIds: string[];
}

export interface SocialAccount extends EntityId {
  kind: "SOCIAL_ACCOUNT";
  platformId: string;
  handle: string;
  displayName?: string;
  profileUrl?: string;
  ownerPersonId?: string;
  metadata: Record<string, unknown>;
}

export interface Platform extends EntityId {
  kind: "PLATFORM";
  slug: string;
  displayName: string;
  enabled: boolean;
}

export interface Content extends EntityId {
  kind: "CONTENT";
  platformId: string;
  authorAccountId: string;
  externalId: string;
  body: string;
  externalCreatedAt: string;
  metadata: Record<string, unknown>;
}

export interface Interaction extends EntityId {
  kind: "INTERACTION";
  platformId: string;
  fromAccountId: string;
  toContentId?: string;
  toAccountId?: string;
  type: string;
  occurredAt: string;
}

export interface Organization extends EntityId {
  kind: "ORGANIZATION";
  name: string;
  website?: string;
  metadata: Record<string, unknown>;
}

export interface Community extends EntityId {
  kind: "COMMUNITY";
  name: string;
  platformId?: string;
  slug?: string;
  metadata: Record<string, unknown>;
}

export interface Relationship extends EntityId {
  kind: "RELATIONSHIP";
  fromPersonId: string;
  toPersonId: string;
  pipelineId: string;
  stageKey: string;
}

export interface Topic extends EntityId {
  kind: "TOPIC";
  label: string;
  metadata: Record<string, unknown>;
}

export interface Opportunity extends EntityId {
  kind: "OPPORTUNITY";
  typeKey: string;
  title: string;
}

export type CoreEntity =
  | Person
  | SocialAccount
  | Platform
  | Content
  | Interaction
  | Organization
  | Community
  | Relationship
  | Topic
  | Opportunity;