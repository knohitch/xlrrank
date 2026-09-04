export type {
  NormalizedProfile,
  NormalizedContent,
  NormalizedInteraction,
  ConnectorSyncResult,
} from "./normalized.js";

export type {
  SocialConnector,
  ConnectorCredentials,
  AuthResult,
  ContentQuery,
  AccountMetrics,
  PaginationCursor,
  SyncResult,
  RateLimitInfo,
} from "./connectors/types.js";

export { BaseSocialConnector } from "./connectors/base.js";
export { ConnectorRegistry, connectorRegistry } from "./connectors/registry.js";
export {
  ConnectorError,
  AuthenticationError,
  RateLimitError,
  CapabilityUnavailableError,
} from "./connectors/errors.js";

export { XConnector } from "./platforms/x-connector.js";
export { InstagramConnector } from "./platforms/instagram-connector.js";
export { FacebookConnector } from "./platforms/facebook-connector.js";
export { LinkedInConnector } from "./platforms/linkedin-connector.js";
export { RedditConnector } from "./platforms/reddit-connector.js";
