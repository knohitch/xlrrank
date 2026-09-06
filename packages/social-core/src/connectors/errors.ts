import type { ConnectorErrorCategory, RetryClassification } from "./types.js";

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly connectorId: string,
    public readonly code: ConnectorErrorCategory,
    public readonly retryable: boolean = false,
    public readonly retryClassification: RetryClassification = retryable
      ? "RETRYABLE"
      : "NON_RETRYABLE",
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export class AuthenticationError extends ConnectorError {
  constructor(connectorId: string, message = "Authentication failed") {
    super(message, connectorId, "AUTHENTICATION", false, "REAUTH_REQUIRED");
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends ConnectorError {
  constructor(
    connectorId: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(`Rate limited. Retry after ${retryAfterSeconds}s`, connectorId, "RATE_LIMIT", true);
    this.name = "RateLimitError";
  }
}

export class CapabilityUnavailableError extends ConnectorError {
  constructor(connectorId: string, capability: string, reason: string) {
    super(
      `Capability '${capability}' unavailable: ${reason}`,
      connectorId,
      "CAPABILITY_UNAVAILABLE",
      false,
    );
    this.name = "CapabilityUnavailableError";
  }
}

export class AuthorizationError extends ConnectorError {
  constructor(connectorId: string, message = "Provider authorization failed") {
    super(message, connectorId, "AUTHORIZATION", false, "REAUTH_REQUIRED");
    this.name = "AuthorizationError";
  }
}

export class TemporaryProviderError extends ConnectorError {
  constructor(connectorId: string, message = "Temporary provider failure") {
    super(message, connectorId, "TEMPORARY_PROVIDER_FAILURE", true, "RETRYABLE");
    this.name = "TemporaryProviderError";
  }
}

export class PermanentProviderError extends ConnectorError {
  constructor(connectorId: string, message = "Permanent provider failure") {
    super(message, connectorId, "PERMANENT_PROVIDER_FAILURE", false, "NON_RETRYABLE");
    this.name = "PermanentProviderError";
  }
}

export class MalformedProviderResponseError extends ConnectorError {
  constructor(connectorId: string, message = "Malformed provider response") {
    super(message, connectorId, "MALFORMED_PROVIDER_RESPONSE", false, "NON_RETRYABLE");
    this.name = "MalformedProviderResponseError";
  }
}

export class ConnectorConfigurationError extends ConnectorError {
  constructor(connectorId: string, message = "Connector is not configured") {
    super(message, connectorId, "CONFIGURATION", false, "NON_RETRYABLE");
    this.name = "ConnectorConfigurationError";
  }
}
