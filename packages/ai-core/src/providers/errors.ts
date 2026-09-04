export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly code: string,
    public readonly retryable: boolean = false,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export class AuthenticationError extends AiProviderError {
  constructor(provider: string, message = "Authentication failed") {
    super(message, provider, "AUTHENTICATION_ERROR", false, 401);
    this.name = "AiAuthenticationError";
  }
}

export class RateLimitError extends AiProviderError {
  constructor(provider: string, public readonly retryAfterSeconds?: number) {
    super(`Rate limited${retryAfterSeconds ? `. Retry after ${retryAfterSeconds}s` : ""}`, provider, "RATE_LIMIT_ERROR", true, 429);
    this.name = "AiRateLimitError";
  }
}

export class ModelNotFoundError extends AiProviderError {
  constructor(provider: string, model: string) {
    super(`Model '${model}' not found`, provider, "MODEL_NOT_FOUND", false, 404);
    this.name = "ModelNotFoundError";
  }
}

export class ContextLimitExceededError extends AiProviderError {
  constructor(provider: string) {
    super("Context window exceeded", provider, "CONTEXT_LIMIT", false, 400);
    this.name = "ContextLimitExceededError";
  }
}

export class SchemaValidationError extends AiProviderError {
  constructor(provider: string, details: string) {
    super(`Structured output validation failed: ${details}`, provider, "SCHEMA_VALIDATION", false);
    this.name = "SchemaValidationError";
  }
}

export class ProviderUnavailableError extends AiProviderError {
  constructor(provider: string, reason: string) {
    super(`Provider unavailable: ${reason}`, provider, "PROVIDER_UNAVAILABLE", true);
    this.name = "ProviderUnavailableError";
  }
}
