import type { RateLimitInfo } from "../connectors/types.js";
import {
  AuthenticationError,
  AuthorizationError,
  CapabilityUnavailableError,
  ConnectorConfigurationError,
  MalformedProviderResponseError,
  PermanentProviderError,
  RateLimitError,
  TemporaryProviderError,
} from "../connectors/errors.js";

export interface XHttpClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface XResponse<T> {
  body: T;
  rateLimit?: RateLimitInfo;
}

export interface XProblem {
  title?: unknown;
  detail?: unknown;
  type?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
}

export class XHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: XHttpClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.X_API_BASE_URL ?? "https://api.x.com").replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get<T>(
    path: string,
    accessToken: string,
    query?: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<XResponse<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of query) url.searchParams.append(key, value);
    }
    const init: RequestInit = {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    };
    if (signal) init.signal = signal;
    return this.request<T>(url, init);
  }

  async postForm<T>(
    path: string,
    form: URLSearchParams,
    options: {
      basicAuth?: { clientId: string; clientSecret: string };
      signal?: AbortSignal;
    } = {},
  ): Promise<XResponse<T>> {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (options.basicAuth) {
      const encoded = Buffer.from(
        `${options.basicAuth.clientId}:${options.basicAuth.clientSecret}`,
        "utf8",
      ).toString("base64");
      headers.authorization = `Basic ${encoded}`;
    }
    const init: RequestInit = {
      method: "POST",
      headers,
      body: form,
    };
    if (options.signal) init.signal = options.signal;
    return this.request<T>(new URL(`${this.baseUrl}${path}`), init);
  }

  private async request<T>(url: URL, init: RequestInit): Promise<XResponse<T>> {
    const response = await this.fetchImpl(url, init);
    const rateLimit = rateLimitFrom(response);
    const body = await readJson(response);
    if (!response.ok) {
      throw mapXError(response.status, body, rateLimit);
    }
    if (body === null || typeof body !== "object") {
      throw new MalformedProviderResponseError("x", "X response was not a JSON object");
    }
    return rateLimit ? { body: body as T, rateLimit } : { body: body as T };
  }
}

export function rateLimitFrom(response: Response): RateLimitInfo | undefined {
  const remaining = response.headers.get("x-rate-limit-remaining");
  const reset = response.headers.get("x-rate-limit-reset");
  const limit = response.headers.get("x-rate-limit-limit");
  const retryAfter = response.headers.get("retry-after");
  if (remaining === null && reset === null && limit === null && retryAfter === null) {
    return undefined;
  }
  const resetSeconds = reset === null ? undefined : Number.parseInt(reset, 10);
  const retryAfterSeconds = retryAfter === null ? undefined : Number.parseInt(retryAfter, 10);
  return {
    remaining: remaining === null ? 0 : Number.parseInt(remaining, 10),
    limit: limit === null ? undefined : Number.parseInt(limit, 10),
    resetAt:
      resetSeconds === undefined || Number.isNaN(resetSeconds)
        ? undefined
        : new Date(resetSeconds * 1000).toISOString(),
    retryAfter:
      retryAfterSeconds === undefined || Number.isNaN(retryAfterSeconds)
        ? undefined
        : retryAfterSeconds,
    providerMetadata: {
      bucketScope: "endpoint-auth-context",
      headers: {
        hasRateLimitLimit: limit !== null,
        hasRateLimitRemaining: remaining !== null,
        hasRateLimitReset: reset !== null,
      },
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MalformedProviderResponseError("x", "X response was not valid JSON");
  }
}

function providerProblems(body: unknown): XProblem[] {
  if (!body || typeof body !== "object") return [];
  const errors = (body as { errors?: unknown }).errors;
  if (Array.isArray(errors)) return errors.filter((item) => item && typeof item === "object");
  return [];
}

function mapXError(status: number, body: unknown, rateLimit?: RateLimitInfo): Error {
  const problems = providerProblems(body);
  if (status === 401) {
    return new AuthenticationError("x", "X authorization is invalid or expired");
  }
  if (status === 403) {
    const accessLimited = problems.some((problem) => {
      const values = [problem.type, problem.title, problem.detail, problem.message]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();
      return values.includes("access") || values.includes("tier") || values.includes("permission");
    });
    if (accessLimited) {
      return new CapabilityUnavailableError("x", "provider endpoint", "access_tier_required");
    }
    return new AuthorizationError("x", "X authorization does not permit this operation");
  }
  if (status === 429) {
    const retryAfter = rateLimit?.retryAfter ?? secondsUntil(rateLimit?.resetAt) ?? 60;
    return new RateLimitError("x", retryAfter);
  }
  if (status >= 500) {
    return new TemporaryProviderError("x", `X provider status ${status}`);
  }
  if (status >= 400) {
    const oauthError = bodyErrorCode(body);
    if (oauthError === "invalid_grant") {
      return new AuthenticationError("x", "X refresh token is invalid or revoked");
    }
    if (oauthError === "invalid_client") {
      return new ConnectorConfigurationError("x", "X provider app credentials are invalid");
    }
    return new PermanentProviderError("x", `X provider status ${status}`);
  }
  return new PermanentProviderError("x", `Unexpected X provider status ${status}`);
}

function bodyErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

function secondsUntil(resetAt?: string): number | undefined {
  if (!resetAt) return undefined;
  const seconds = Math.ceil((Date.parse(resetAt) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
}
