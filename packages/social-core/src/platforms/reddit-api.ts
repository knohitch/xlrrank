import type { RateLimitInfo } from "../connectors/types.js";
import {
  AuthenticationError,
  AuthorizationError,
  ConnectorConfigurationError,
  MalformedProviderResponseError,
  PermanentProviderError,
  RateLimitError,
  TemporaryProviderError,
} from "../connectors/errors.js";

export interface RedditHttpClientOptions {
  baseUrl?: string;
  tokenBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface RedditResponse<T> {
  body: T;
  rateLimit?: RateLimitInfo | undefined;
}

export class RedditHttpClient {
  private readonly baseUrl: string;
  private readonly tokenBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RedditHttpClientOptions = {}) {
    this.baseUrl = validateRedditBaseUrl(
      options.baseUrl ?? process.env.REDDIT_API_BASE_URL ?? "https://oauth.reddit.com",
      "https://oauth.reddit.com",
      "REDDIT_API_BASE_URL",
    );
    this.tokenBaseUrl = validateRedditBaseUrl(
      options.tokenBaseUrl ?? process.env.REDDIT_TOKEN_BASE_URL ?? "https://www.reddit.com",
      "https://www.reddit.com",
      "REDDIT_TOKEN_BASE_URL",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get<T>(
    path: string,
    accessToken: string,
    userAgent: string,
    query?: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<RedditResponse<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of query) url.searchParams.append(key, value);
    }
    const init: RequestInit = {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "user-agent": userAgent,
      },
    };
    if (signal) init.signal = signal;
    return this.request<T>(url, init);
  }

  async postTokenForm<T>(
    path: string,
    form: URLSearchParams,
    options: {
      clientId: string;
      clientSecret: string;
      signal?: AbortSignal | undefined;
    },
  ): Promise<RedditResponse<T>> {
    const encoded = Buffer.from(`${options.clientId}:${options.clientSecret}`, "utf8").toString(
      "base64",
    );
    const init: RequestInit = {
      method: "POST",
      headers: {
        authorization: `Basic ${encoded}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    };
    if (options.signal) init.signal = options.signal;
    return this.request<T>(new URL(`${this.tokenBaseUrl}${path}`), init);
  }

  private async request<T>(url: URL, init: RequestInit): Promise<RedditResponse<T>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new TemporaryProviderError("reddit", "Reddit provider request timed out");
      }
      throw new TemporaryProviderError("reddit", "Reddit provider request failed");
    }
    const rateLimit = redditRateLimitFrom(response);
    const body = await readJson(response);
    if (!response.ok) {
      throw mapRedditError(response.status, body, rateLimit);
    }
    if (body === null || typeof body !== "object") {
      throw new MalformedProviderResponseError("reddit", "Reddit response was not a JSON object");
    }
    return rateLimit ? { body: body as T, rateLimit } : { body: body as T };
  }
}

export function redditRateLimitFrom(response: Response): RateLimitInfo | undefined {
  const used = response.headers.get("x-ratelimit-used");
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  const retryAfter = response.headers.get("retry-after");
  if (used === null && remaining === null && reset === null && retryAfter === null) {
    return undefined;
  }
  const resetSeconds = reset === null ? undefined : Number.parseFloat(reset);
  const retryAfterSeconds = retryAfter === null ? undefined : Number.parseInt(retryAfter, 10);
  return {
    remaining: remaining === null ? 0 : Math.floor(Number.parseFloat(remaining)),
    resetAt:
      resetSeconds === undefined || Number.isNaN(resetSeconds)
        ? undefined
        : new Date(Date.now() + resetSeconds * 1000).toISOString(),
    retryAfter:
      retryAfterSeconds === undefined || Number.isNaN(retryAfterSeconds)
        ? undefined
        : retryAfterSeconds,
    providerMetadata: {
      provider: "reddit",
      headers: {
        used: used === null ? undefined : Number.parseFloat(used),
        hasRateLimitUsed: used !== null,
        hasRateLimitRemaining: remaining !== null,
        hasRateLimitReset: reset !== null,
      },
    },
  };
}

export function validateRedditUserAgent(value: unknown): string {
  if (typeof value !== "string") {
    throw new ConnectorConfigurationError(
      "reddit",
      "Reddit API calls require configured provider metadata userAgent",
    );
  }
  const trimmed = value.trim();
  if (
    trimmed.length < 12 ||
    /^mozilla\//i.test(trimmed) ||
    /^curl\//i.test(trimmed) ||
    /^python-requests\//i.test(trimmed)
  ) {
    throw new ConnectorConfigurationError(
      "reddit",
      "Reddit userAgent must be truthful, descriptive, and non-spoofed",
    );
  }
  return trimmed;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MalformedProviderResponseError("reddit", "Reddit response was not valid JSON");
  }
}

function mapRedditError(status: number, body: unknown, rateLimit?: RateLimitInfo): Error {
  const oauthError = bodyErrorCode(body);
  if (status === 401 || oauthError === "invalid_grant") {
    return new AuthenticationError("reddit", "Reddit authorization is invalid or expired");
  }
  if (status === 403) {
    return new AuthorizationError("reddit", "Reddit authorization does not permit this operation");
  }
  if (status === 429) {
    const retryAfter = rateLimit?.retryAfter ?? secondsUntil(rateLimit?.resetAt) ?? 60;
    return new RateLimitError("reddit", retryAfter);
  }
  if (status >= 500) {
    return new TemporaryProviderError("reddit", `Reddit provider status ${status}`);
  }
  if (status >= 400) {
    if (oauthError === "invalid_client") {
      return new ConnectorConfigurationError("reddit", "Reddit app credentials are invalid");
    }
    return new PermanentProviderError("reddit", `Reddit provider status ${status}`);
  }
  return new PermanentProviderError("reddit", `Unexpected Reddit provider status ${status}`);
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

function validateRedditBaseUrl(value: string, productionUrl: string, variable: string): string {
  const url = new URL(value);
  const normalized = url.toString().replace(/\/+$/, "");
  if (normalized === productionUrl) return normalized;
  if (process.env.NODE_ENV === "production") {
    throw new ConnectorConfigurationError(
      "reddit",
      `${variable} may not override the approved Reddit production host`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorConfigurationError("reddit", `${variable} must use http or https`);
  }
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new ConnectorConfigurationError(
      "reddit",
      `${variable} test override must target localhost`,
    );
  }
  return normalized;
}
