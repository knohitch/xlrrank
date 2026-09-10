export type {
  NormalizedProfile,
  NormalizedContent,
  NormalizedInteraction,
  ConnectorSyncResult,
  NormalizationProvenance,
  NormalizedInteractionType,
  SocialVisibility,
} from "./normalized.js";
export { NORMALIZATION_VERSION } from "./normalized.js";

export type {
  SocialConnector,
  ConnectorCredentials,
  CapabilityEvaluationInput,
  ProviderApplicationConfig,
  OAuthAuthorizationRequest,
  OAuthTokenExchangeRequest,
  OAuthTokenRefreshRequest,
  OAuthTokenResult,
  OAuthProviderContract,
  OAuthProviderAdapter,
  OAuthCapableConnector,
  ProviderAsset,
  ProviderEventSubscriptionRequest,
  ProviderEventSubscriptionResult,
  ProviderWebhookAdapter,
  AuthResult,
  ContentQuery,
  AccountMetrics,
  PaginationCursor,
  SyncResult,
  RateLimitInfo,
  ConnectorErrorCategory,
  ConnectorOperationContext,
  PageResult,
  RetryClassification,
} from "./connectors/types.js";

export { BaseSocialConnector } from "./connectors/base.js";
export { ConnectorRegistry, connectorRegistry } from "./connectors/registry.js";
export type { ConnectorDefinition } from "./connectors/registry.js";
export {
  ConnectorError,
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  CapabilityUnavailableError,
  ConnectorConfigurationError,
  MalformedProviderResponseError,
  PermanentProviderError,
  TemporaryProviderError,
} from "./connectors/errors.js";
export {
  DEFAULT_SOCIAL_PAYLOAD_LIMITS,
  validateNormalizedContent,
  validateNormalizedInteraction,
  validateNormalizedProfile,
} from "./validation.js";
export type { SocialPayloadLimits } from "./validation.js";
export { redactProviderMetadata } from "./security/redaction.js";
export { ReferenceHttpConnector } from "./testing/reference-connector.js";

export {
  XConnector,
  buildRecentSearchQuery,
  evaluateXCapabilities,
  getXCapabilityMatrix,
} from "./platforms/x-connector.js";
export { InstagramConnector, evaluateInstagramCapabilities } from "./platforms/instagram-connector.js";
export { FacebookConnector, evaluateFacebookCapabilities } from "./platforms/facebook-connector.js";
export {
  META_GRAPH_API_VERSION,
  appSecretProof,
  decodeMetaCursor,
  encodeMetaCursor,
} from "./platforms/meta-api.js";
export type { MetaAsset } from "./platforms/facebook-connector.js";
export {
  LinkedInConnector,
  evaluateLinkedInCapabilities,
  LINKEDIN_DEFAULT_SCOPES,
  LINKEDIN_CAPABILITY_MATRIX,
} from "./platforms/linkedin-connector.js";
export type { LinkedInAsset } from "./platforms/linkedin-connector.js";
export type {
  LinkedInOrganizationNotificationSubscriptionInput,
  LinkedInOrganizationNotificationSubscriptionResult,
} from "./platforms/linkedin-connector.js";
export {
  LINKEDIN_MARKETING_API_VERSION,
  LINKEDIN_REST_BASE_URL,
  LINKEDIN_OAUTH_AUTHORIZE_URL,
  LINKEDIN_OAUTH_TOKEN_URL,
  LINKEDIN_OIDC_USERINFO_URL,
  LINKEDIN_RESTLI_PROTOCOL_VERSION,
  LinkedInApiClient,
  verifyLinkedInWebhookChallenge,
  verifyLinkedInWebhookSignature,
  linkedInWebhookDedupeKey,
  encodeLinkedInCursor,
  decodeLinkedInCursor,
  mapLinkedInError,
  parseLinkedInRateLimit,
} from "./platforms/linkedin-api.js";
export { RedditConnector, evaluateRedditCapabilities } from "./platforms/reddit-connector.js";
export { RedditHttpClient, redditRateLimitFrom, validateRedditUserAgent } from "./platforms/reddit-api.js";
