export interface NormalizedProfile {
  platformId: string;
  externalId: string;
  handle: string;
  displayName?: string;
  bio?: string;
  location?: string;
  website?: string;
  profileImageUrl?: string;
  followerCount?: number;
  followingCount?: number;
  metadata: Record<string, unknown>;
}

export interface NormalizedContent {
  platformId: string;
  authorExternalId: string;
  externalId: string;
  body: string;
  contentType?: string;
  externalCreatedAt?: string;
  metadata: Record<string, unknown>;
}

export interface NormalizedInteraction {
  platformId: string;
  fromExternalId: string;
  toContentExternalId?: string;
  toAccountExternalId?: string;
  type: string;
  body?: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

export interface ConnectorSyncResult {
  profilesSynced: number;
  contentSynced: number;
  interactionsSynced: number;
  errors: Array<{ reason: string; perma: boolean }>;
}
