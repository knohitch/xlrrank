export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly connectorId: string,
    public readonly code: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export class AuthenticationError extends ConnectorError {
  constructor(connectorId: string, message = "Authentication failed") {
    super(message, connectorId, "AUTHENTICATION_ERROR", false);
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends ConnectorError {
  constructor(
    connectorId: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(`Rate limited. Retry after ${retryAfterSeconds}s`, connectorId, "RATE_LIMIT_ERROR", true);
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
