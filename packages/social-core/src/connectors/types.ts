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

export interface ProviderApplicationConfig {
  platformId: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  enabled: boolean;
  metadata?: Record<string, unknown>;
}

export interface OAuthAuthorizationRequest {
  providerConfig: ProviderApplicationConfig;
  contract?: OAuthProviderContract;
  state: string;
  codeChallenge: string;
  requestedScopes: string[];
}

export interface OAuthTokenExchangeRequest {
  providerConfig: ProviderApplicationConfig;
  contract?: OAuthProviderContract;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface OAuthTokenRefreshRequest {
  providerConfig: ProviderApplicationConfig;
  contract?: OAuthProviderContract;
  refreshToken: string;
}

export interface OAuthProviderContract {
  id?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  defaultScopes: string[];
  pkceRequired: boolean;
  supportsRefresh: boolean;
  supportsRevocation: boolean;
  apiBaseUrl?: string | undefined;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string | undefined;
  tokenType?: string | undefined;
  expiresAt?: string | undefined;
  expiresIn?: number | undefined;
  grantedScopes: string[];
  rawProviderMetadata?: Record<string, unknown> | undefined;
}

export interface OAuthProviderAdapter {
  buildAuthorizationUrl(request: OAuthAuthorizationRequest): URL;
  exchangeAuthorizationCode(
    request: OAuthTokenExchangeRequest,
    signal?: AbortSignal,
  ): Promise<OAuthTokenResult>;
  refreshAccessToken(
    request: OAuthTokenRefreshRequest,
    signal?: AbortSignal,
  ): Promise<OAuthTokenResult>;
  verifyIdentity(
    credentials: ConnectorCredentials,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile>;
  revoke?(
    credentials: ConnectorCredentials,
    providerConfig: ProviderApplicationConfig,
    signal?: AbortSignal,
  ): Promise<{ providerRevoked: boolean; reason?: string }>;
}

export interface OAuthCapableConnector extends SocialConnector {
  getOAuthAdapter(): OAuthProviderAdapter;
}

export interface CapabilityEvaluationInput {
  configured: boolean;
  grantedScopes?: string[];
  access?: Record<string, unknown>;
  authMode?: string | undefined;
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
  value: string | null;
  hasMore: boolean;
}

export interface PageResult<T> {
  items: T[];
  cursor: PaginationCursor;
  rateLimit?: RateLimitInfo | undefined;
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
  resetAt?: string | undefined;
  retryAfter?: number | undefined;
  limit?: number | undefined;
  providerMetadata?: Record<string, unknown> | undefined;
}

export type ConnectorErrorCategory =
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "RATE_LIMIT"
  | "TEMPORARY_PROVIDER_FAILURE"
  | "PERMANENT_PROVIDER_FAILURE"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "CAPABILITY_UNAVAILABLE"
  | "CONFIGURATION";

export type RetryClassification = "RETRYABLE" | "NON_RETRYABLE" | "REAUTH_REQUIRED";

export interface ConnectorOperationContext {
  scopeId: string;
  connectionId: string;
  credentials: ConnectorCredentials;
  signal?: AbortSignal;
}

export interface SocialConnector {
  getManifest(): ConnectorManifest;
  getStatus(): ConnectorStatus;
  checkHealth(): Promise<boolean>;
  getCapabilities(): Partial<Record<ConnectorCapability, AvailabilityState>>;
  evaluateCapabilities?(
    input: CapabilityEvaluationInput,
  ): Partial<Record<ConnectorCapability, AvailabilityState>>;
  authenticate(
    credentials: ConnectorCredentials,
    context?: ConnectorOperationContext,
  ): Promise<AuthResult>;
  disconnect(): Promise<void>;
  getAuthenticatedProfile(context?: ConnectorOperationContext): Promise<NormalizedProfile | null>;
  getProfile(
    identifier: string,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile | null>;
  getContent(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedContent[]>;
  getContentPage(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedContent>>;
  getComments(
    contentId: string,
    options?: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedInteraction[]>;
  getInteractionsPage(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedInteraction>>;
  searchProfiles(
    query: string,
    limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]>;
  searchContent(
    query: string,
    limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedContent[]>;
  getMetrics(accountId: string, context?: ConnectorOperationContext): Promise<AccountMetrics>;
  getFollowers(
    accountId: string,
    limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]>;
  getFollowing(
    accountId: string,
    limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]>;
}
