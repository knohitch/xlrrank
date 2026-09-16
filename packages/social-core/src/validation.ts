import type {
  NormalizedContent,
  NormalizedInteraction,
  NormalizedProfile,
  NormalizedInteractionType,
  SocialVisibility,
} from "./normalized.js";
import { assertMetadataSize } from "./security/redaction.js";

export interface SocialPayloadLimits {
  profileBioLength: number;
  contentBodyLength: number;
  interactionBodyLength: number;
  providerMetadataBytes: number;
  rawPayloadBytes: number;
}

export const DEFAULT_SOCIAL_PAYLOAD_LIMITS: SocialPayloadLimits = {
  profileBioLength: 4_000,
  contentBodyLength: 20_000,
  interactionBodyLength: 10_000,
  providerMetadataBytes: 16_384,
  rawPayloadBytes: 65_536,
};

const VISIBILITIES = new Set<SocialVisibility>([
  "PUBLIC",
  "SCOPE_PRIVATE",
  "RESTRICTED",
  "UNKNOWN",
]);
const INTERACTION_TYPES = new Set<NormalizedInteractionType>([
  "COMMENT",
  "REPLY",
  "MENTION",
  "LIKE",
  "REPOST",
  "FOLLOW",
]);

function requireText(value: string, field: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

function assertOptionalUrl(value: string | undefined, field: string): void {
  if (!value) return;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${field} must be http or https`);
  }
}

function assertDate(value: string | undefined, field: string): void {
  if (!value) return;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error(`${field} must be a valid timestamp`);
}

function assertVisibility(value: SocialVisibility): void {
  if (!VISIBILITIES.has(value)) throw new Error(`invalid visibility: ${value}`);
}

function assertNonnegative(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be nonnegative`);
}

export function validateNormalizedProfile(
  profile: NormalizedProfile,
  limits: SocialPayloadLimits = DEFAULT_SOCIAL_PAYLOAD_LIMITS,
): void {
  requireText(profile.platformId, "profile.platformId");
  requireText(profile.externalId, "profile.externalId");
  requireText(profile.handle, "profile.handle");
  assertVisibility(profile.visibility);
  if ((profile.bio?.length ?? 0) > limits.profileBioLength) {
    throw new Error("profile.bio exceeds configured limit");
  }
  assertOptionalUrl(profile.website, "profile.website");
  assertOptionalUrl(profile.profileImageUrl, "profile.profileImageUrl");
  assertNonnegative(profile.followerCount, "profile.followerCount");
  assertNonnegative(profile.followingCount, "profile.followingCount");
  assertDate(profile.providerCreatedAt, "profile.providerCreatedAt");
  assertMetadataSize(profile.metadata, limits.providerMetadataBytes, "profile.metadata");
}

export function validateNormalizedContent(
  content: NormalizedContent,
  limits: SocialPayloadLimits = DEFAULT_SOCIAL_PAYLOAD_LIMITS,
): void {
  requireText(content.platformId, "content.platformId");
  requireText(content.authorExternalId, "content.authorExternalId");
  requireText(content.externalId, "content.externalId");
  requireText(content.body, "content.body");
  assertVisibility(content.visibility);
  if (content.body.length > limits.contentBodyLength) {
    throw new Error("content.body exceeds configured limit");
  }
  assertDate(content.externalCreatedAt, "content.externalCreatedAt");
  assertNonnegative(content.metrics?.likes, "content.metrics.likes");
  assertNonnegative(content.metrics?.comments, "content.metrics.comments");
  assertNonnegative(content.metrics?.shares, "content.metrics.shares");
  assertNonnegative(content.metrics?.impressions, "content.metrics.impressions");
  assertMetadataSize(content.metadata, limits.providerMetadataBytes, "content.metadata");
}

export function validateNormalizedInteraction(
  interaction: NormalizedInteraction,
  limits: SocialPayloadLimits = DEFAULT_SOCIAL_PAYLOAD_LIMITS,
): void {
  requireText(interaction.platformId, "interaction.platformId");
  requireText(interaction.externalId, "interaction.externalId");
  requireText(interaction.fromExternalId, "interaction.fromExternalId");
  if (!INTERACTION_TYPES.has(interaction.type)) {
    throw new Error(`invalid interaction.type: ${interaction.type}`);
  }
  assertVisibility(interaction.visibility);
  if ((interaction.body?.length ?? 0) > limits.interactionBodyLength) {
    throw new Error("interaction.body exceeds configured limit");
  }
  assertDate(interaction.occurredAt, "interaction.occurredAt");
  assertMetadataSize(interaction.metadata, limits.providerMetadataBytes, "interaction.metadata");
}
