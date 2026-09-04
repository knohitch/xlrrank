import type {
  ConnectorCapability,
  ConnectorManifest,
  ConnectorStatus,
  AvailabilityState,
} from "@xlrrank/shared";
import type { NormalizedProfile, NormalizedContent, NormalizedInteraction } from "../normalized.js";
export type { NormalizedProfile, NormalizedContent, NormalizedInteraction };

export interface ConnectorCredentials {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface AuthResult {
  success: boolean;
  status: ConnectorStatus;
  profile?: NormalizedProfile;
  error?: string;
}

export interface ContentQuery {
  accountId?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  query?: string;
}

export interface AccountMetrics {
  followerCount: number;
  followingCount: number;
  contentCount: number;
  engagementRate?: number;
  collectedAt: string;
}

export interface PaginationCursor {
  value: string;
  hasMore: boolean;
}

export interface SyncResult {
  profilesSynced: number;
  contentSynced: number;
  interactionsSynced: number;
  cursor?: PaginationCursor;
  errors: Array<{ message: string; permanent: boolean }>;
}

export interface RateLimitInfo {
  remaining: number;
  resetAt: string;
  limit: number;
}

export interface SocialConnector {
  getManifest(): ConnectorManifest;
  getStatus(): ConnectorStatus;
  checkHealth(): Promise<boolean>;
  getCapabilities(): Partial<Record<ConnectorCapability, AvailabilityState>>;
  authenticate(credentials: ConnectorCredentials): Promise<AuthResult>;
  disconnect(): Promise<void>;
  getAuthenticatedProfile(): Promise<NormalizedProfile | null>;
  getProfile(identifier: string): Promise<NormalizedProfile | null>;
  getContent(options: ContentQuery): Promise<NormalizedContent[]>;
  getComments(contentId: string, options?: ContentQuery): Promise<NormalizedInteraction[]>;
  searchProfiles(query: string, limit?: number): Promise<NormalizedProfile[]>;
  searchContent(query: string, limit?: number): Promise<NormalizedContent[]>;
  getMetrics(accountId: string): Promise<AccountMetrics>;
  getFollowers(accountId: string, limit?: number): Promise<NormalizedProfile[]>;
  getFollowing(accountId: string, limit?: number): Promise<NormalizedProfile[]>;
}
