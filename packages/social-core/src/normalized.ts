export const NORMALIZATION_VERSION = "social-normalized-v2";

export type SocialVisibility = "PUBLIC" | "SCOPE_PRIVATE" | "RESTRICTED" | "UNKNOWN";
export type NormalizedInteractionType =
  "COMMENT" | "REPLY" | "MENTION" | "LIKE" | "REPOST" | "FOLLOW";

export interface NormalizationProvenance {
  platformId: string;
  connectionId?: string | undefined;
  scopeId?: string | undefined;
  observedAt: string;
  providerCreatedAt?: string | undefined;
  normalizationVersion: string;
  adapterVersion: string;
  ingestionRunId?: string | undefined;
  visibility: SocialVisibility;
}

export interface NormalizedProfile {
  platformId: string;
  externalId: string;
  handle: string;
  displayName?: string | undefined;
  bio?: string | undefined;
  location?: string | undefined;
  website?: string | undefined;
  profileImageUrl?: string | undefined;
  followerCount?: number | undefined;
  followingCount?: number | undefined;
  visibility: SocialVisibility;
  providerCreatedAt?: string | undefined;
  provenance: NormalizationProvenance;
  metadata: Record<string, unknown>;
}

export interface NormalizedContent {
  platformId: string;
  authorExternalId: string;
  externalId: string;
  body: string;
  contentType?: string | undefined;
  language?: string | undefined;
  externalCreatedAt?: string | undefined;
  visibility: SocialVisibility;
  metrics?:
    | {
        likes?: number | undefined;
        comments?: number | undefined;
        shares?: number | undefined;
        impressions?: number | undefined;
        engagementRate?: number | undefined;
        snapshotKey?: string | undefined;
      }
    | undefined;
  provenance: NormalizationProvenance;
  metadata: Record<string, unknown>;
}

export interface NormalizedInteraction {
  platformId: string;
  fromExternalId: string;
  toContentExternalId?: string | undefined;
  toAccountExternalId?: string | undefined;
  externalId: string;
  type: NormalizedInteractionType;
  body?: string | undefined;
  occurredAt: string;
  visibility: SocialVisibility;
  provenance: NormalizationProvenance;
  metadata: Record<string, unknown>;
}

export interface ConnectorSyncResult {
  profilesSynced: number;
  contentSynced: number;
  interactionsSynced: number;
  errors: Array<{ reason: string; perma: boolean }>;
}
