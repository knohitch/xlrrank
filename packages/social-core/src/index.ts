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

export { XConnector } from "./platforms/x-connector.js";
export { InstagramConnector } from "./platforms/instagram-connector.js";
export { FacebookConnector } from "./platforms/facebook-connector.js";
export { LinkedInConnector } from "./platforms/linkedin-connector.js";
export { RedditConnector } from "./platforms/reddit-connector.js";
