export type {
  SocialConnector,
  ConnectorCredentials,
  AuthResult,
  ContentQuery,
  AccountMetrics,
  PaginationCursor,
  SyncResult,
  RateLimitInfo,
  NormalizedProfile,
  NormalizedContent,
  NormalizedInteraction,
  ConnectorSyncResult,
} from "@xlrrank/social-core";

export {
  BaseSocialConnector,
  ConnectorRegistry,
  connectorRegistry,
  ConnectorError,
  AuthenticationError,
  RateLimitError,
  CapabilityUnavailableError,
  XConnector,
  InstagramConnector,
  FacebookConnector,
  LinkedInConnector,
  RedditConnector,
} from "@xlrrank/social-core";
