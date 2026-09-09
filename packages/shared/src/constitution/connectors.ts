/**
 * Architectural Law #6 — Capability-driven connectors.
 * Architectural Law #7 — No fake success.
 *
 * A connector reports its abilities. The application checks capabilities rather
 * than assuming every platform supports the same features. When a capability is
 * unavailable, the state is explicit and honest — never fabricated.
 */

export const CONNECTOR_CAPABILITIES = [
  "profiles",
  "content",
  "comments",
  "search",
  "metrics",
  "followers",
  "following",
  "audience_insights",
  "messages",
  "publishing",
] as const;

export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export const AVAILABILITY_STATES = [
  "AVAILABLE",
  "CONFIGURATION_REQUIRED",
  "PERMISSION_REQUIRED",
  "ACCESS_TIER_REQUIRED",
  "APP_REVIEW_REQUIRED",
  "UNAVAILABLE",
] as const;

export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

export const CONNECTOR_STATUSES = [
  "CONNECTED",
  "DISCONNECTED",
  "AUTHENTICATION_EXPIRED",
  "REAUTH_REQUIRED",
  "PERMISSION_MISSING",
  "RATE_LIMITED",
  "CONFIGURATION_UNAVAILABLE",
  "HEALTHY",
  "DEGRADED",
  "DEMO",
] as const;

export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export interface ConnectorManifest {
  id: string;
  platformId: string;
  name: string;
  version: string;
  apiVersion?: string;
  capabilities: Partial<Record<ConnectorCapability, AvailabilityState>>;
  providerConfig?: {
    fields: Array<{
      key: string;
      label: string;
      required: boolean;
      secret: boolean;
      kind: "string" | "url" | "boolean";
    }>;
  };
  oauth?: {
    type: "authorization_code_pkce";
    authorizationEndpoint: string;
    tokenEndpoint: string;
    defaultScopes: string[];
    pkceRequired: boolean;
    supportsRefresh: boolean;
    supportsRevocation: boolean;
    authModes?: Array<{
      id: string;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      defaultScopes: string[];
      pkceRequired?: boolean;
      supportsRefresh?: boolean;
      supportsRevocation?: boolean;
      apiBaseUrl?: string;
      capabilities?: Partial<Record<ConnectorCapability, AvailabilityState>>;
    }>;
  };
}
