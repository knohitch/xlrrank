import { createHmac, timingSafeEqual } from "node:crypto";
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

/**
 * Baseline: Marketing API version 202608, verified 2026-09-09.
 * Rest.li Protocol: 2.0.0
 * Known upgrade policy: LinkedIn releases monthly version tags in format YYYYMM.
 */
export const LINKEDIN_MARKETING_API_VERSION = "202608";
export const LINKEDIN_REST_BASE_URL = "https://api.linkedin.com/rest";
export const LINKEDIN_OAUTH_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_OAUTH_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_OIDC_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
export const LINKEDIN_RESTLI_PROTOCOL_VERSION = "2.0.0";

const TRUSTED_LINKEDIN_HOSTS = new Set([
  "api.linkedin.com",
  "www.linkedin.com",
  "127.0.0.1",
  "localhost",
]);

export interface LinkedInHttpClientOptions {
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  connectorId?: string | undefined;
  apiVersion?: string | undefined;
}

export interface LinkedInResponse<T> {
  body: T;
  rateLimit?: RateLimitInfo | undefined;
}

export interface LinkedInPaging {
  start: number;
  count: number;
  total?: number | undefined;
  links?: Array<{ rel: string; href: string; type: string }> | undefined;
}

export interface LinkedInElementsResponse<T> {
  elements: T[];
  paging?: LinkedInPaging | undefined;
}

export class LinkedInApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly connectorId: string;
  private readonly apiVersion: string;

  constructor(options: LinkedInHttpClientOptions = {}) {
    this.baseUrl = normalizeLinkedInBaseUrl(
      options.baseUrl ?? process.env.LINKEDIN_REST_BASE_URL ?? LINKEDIN_REST_BASE_URL,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.connectorId = options.connectorId ?? "linkedin";
    this.apiVersion = options.apiVersion ?? LINKEDIN_MARKETING_API_VERSION;
  }

  async get<T>(
    path: string,
    accessToken: string,
    query?: URLSearchParams | Record<string, string | number | undefined>,
    options: { signal?: AbortSignal | undefined; isRest?: boolean | undefined } = {},
  ): Promise<LinkedInResponse<T>> {
    const url = this.url(path);
    if (query) {
      if (query instanceof URLSearchParams) {
        for (const [key, value] of query) url.searchParams.append(key, value);
      } else {
        for (const [key, value] of Object.entries(query)) {
          if (value !== undefined) url.searchParams.append(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Linkedin-Version": this.apiVersion,
      "X-Restli-Protocol-Version": LINKEDIN_RESTLI_PROTOCOL_VERSION,
    };

    const init: RequestInit = {
      method: "GET",
      headers,
    };
    if (options.signal) init.signal = options.signal;
    return this.request<T>(url, init);
  }

  async post<T>(
    path: string,
    accessToken: string,
    data: unknown,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<LinkedInResponse<T>> {
    const url = this.url(path);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Linkedin-Version": this.apiVersion,
      "X-Restli-Protocol-Version": LINKEDIN_RESTLI_PROTOCOL_VERSION,
    };

    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(data),
    };
    if (options.signal) init.signal = options.signal;
    return this.request<T>(url, init);
  }

  async postForm<T>(
    urlStr: string,
    form: URLSearchParams,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<LinkedInResponse<T>> {
    const parsed = new URL(urlStr);
    assertTrustedHost(parsed.hostname);

    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form,
    };
    if (options.signal) init.signal = options.signal;
    return this.request<T>(parsed, init);
  }

  private url(path: string): URL {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    // If path begins with http/https, validate and return
    if (path.startsWith("http://") || path.startsWith("https://")) {
      const parsed = new URL(path);
      assertTrustedHost(parsed.hostname);
      return parsed;
    }
    return new URL(`${this.baseUrl}${normalized}`);
  }

  private async request<T>(url: URL, init: RequestInit): Promise<LinkedInResponse<T>> {
    const response = await this.fetchImpl(url, init);
    const rateLimit = parseLinkedInRateLimit(response);
    const body = await readJson(response, this.connectorId);

    if (!response.ok) {
      throw mapLinkedInError(this.connectorId, response.status, body, rateLimit);
    }
    if (body === null || typeof body !== "object") {
      throw new MalformedProviderResponseError(this.connectorId, "LinkedIn response was not a valid object");
    }
    return rateLimit ? { body: body as T, rateLimit } : { body: body as T };
  }
}

export function normalizeLinkedInBaseUrl(raw: string): string {
  const url = new URL(raw);
  assertTrustedHost(url.hostname);
  return url.toString().replace(/\/+$/, "");
}

function assertTrustedHost(hostname: string): void {
  if (!TRUSTED_LINKEDIN_HOSTS.has(hostname) && !hostname.endsWith(".linkedin.com")) {
    throw new ConnectorConfigurationError(
      "linkedin",
      `Untrusted LinkedIn API host '${hostname}'. SSRF protection blocked request.`,
    );
  }
}

async function readJson(response: Response, connectorId: string): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new MalformedProviderResponseError(connectorId, "Failed to parse provider response JSON");
  }
}

export function parseLinkedInRateLimit(response: Response): RateLimitInfo | undefined {
  const remainingHeader =
    response.headers.get("x-li-ratelimit-remaining") ??
    response.headers.get("x-rate-limit-remaining");
  const resetHeader =
    response.headers.get("x-li-ratelimit-reset") ??
    response.headers.get("x-rate-limit-reset");
  const limitHeader =
    response.headers.get("x-li-ratelimit-limit") ??
    response.headers.get("x-rate-limit-limit");
  const retryAfterHeader = response.headers.get("retry-after");

  const remaining = remainingHeader ? parseInt(remainingHeader, 10) : undefined;
  const limit = limitHeader ? parseInt(limitHeader, 10) : undefined;
  const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

  let resetAt: string | undefined;
  if (resetHeader) {
    const resetNum = parseInt(resetHeader, 10);
    if (!Number.isNaN(resetNum)) {
      // If seconds from epoch vs milliseconds
      resetAt = new Date(resetNum > 1e11 ? resetNum : resetNum * 1000).toISOString();
    }
  }

  if (remaining !== undefined || retryAfter !== undefined) {
    return {
      remaining: remaining ?? (response.status === 429 ? 0 : 1),
      resetAt,
      retryAfter: retryAfter ?? (response.status === 429 ? 60 : undefined),
      limit,
      providerMetadata: {
        rawHeaders: {
          remaining: remainingHeader,
          reset: resetHeader,
          limit: limitHeader,
          retryAfter: retryAfterHeader,
        },
      },
    };
  }

  return undefined;
}

export function mapLinkedInError(
  connectorId: string,
  status: number,
  body: unknown,
  rateLimit?: RateLimitInfo,
): Error {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message =
    (typeof record.message === "string" ? record.message : undefined) ??
    (typeof record.error_description === "string" ? record.error_description : undefined) ??
    (typeof record.error === "string" ? record.error : undefined) ??
    `LinkedIn API returned HTTP ${status}`;
  const serviceErrorCode = typeof record.serviceErrorCode === "number" ? record.serviceErrorCode : undefined;

  if (status === 401) {
    return new AuthenticationError(connectorId, `LinkedIn authentication expired or invalid: ${message}`);
  }

  if (status === 403) {
    const lower = message.toLowerCase();
    if (
      lower.includes("member not authorized") ||
      lower.includes("role") ||
      lower.includes("access control") ||
      lower.includes("organization") ||
      serviceErrorCode === 100
    ) {
      return new AuthorizationError(
        connectorId,
        `LinkedIn member lacks required organization role: ${message}`,
        "NON_RETRYABLE",
      );
    }
    if (
      lower.includes("product") ||
      lower.includes("permission") ||
      lower.includes("scope") ||
      lower.includes("developer application") ||
      lower.includes("not approved")
    ) {
      return new AuthorizationError(
        connectorId,
        `LinkedIn API product or permission access required: ${message}`,
        "NON_RETRYABLE",
      );
    }
    return new AuthorizationError(connectorId, `LinkedIn authorization denied: ${message}`, "NON_RETRYABLE");
  }

  if (status === 429) {
    const seconds = rateLimit?.retryAfter ?? 60;
    return new RateLimitError(connectorId, seconds);
  }

  if (status >= 500) {
    return new TemporaryProviderError(connectorId, `LinkedIn service temporary failure: ${message}`);
  }

  return new PermanentProviderError(connectorId, `LinkedIn API error: ${message}`);
}

/**
 * Verifies LinkedIn Webhook Challenge-Response handshake.
 * GET ?challengeCode=<uuid>
 * Computes HMAC-SHA256(challengeCode, clientSecret)
 */
export function verifyLinkedInWebhookChallenge(
  challengeCode: string,
  clientSecret: string,
): { challengeCode: string; challengeResponse: string } {
  const challengeResponse = createHmac("sha256", clientSecret)
    .update(challengeCode, "utf8")
    .digest("hex");
  return { challengeCode, challengeResponse };
}

/**
 * Verifies incoming notification signature from X-LI-Signature header.
 */
export function verifyLinkedInWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  clientSecret: string,
): boolean {
  if (!signatureHeader || !clientSecret) return false;

  let expectedHex = signatureHeader.trim();
  if (expectedHex.startsWith("hmacsha256=")) {
    expectedHex = expectedHex.slice("hmacsha256=".length);
  } else if (expectedHex.startsWith("sha256=")) {
    expectedHex = expectedHex.slice("sha256=".length);
  }

  const computed = createHmac("sha256", clientSecret)
    .update(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"))
    .digest("hex");

  if (expectedHex.length !== computed.length) return false;
  return timingSafeEqual(Buffer.from(computed, "utf8"), Buffer.from(expectedHex, "utf8"));
}

/**
 * Deterministic deduplication key for LinkedIn Organization Social Action notifications.
 */
export function linkedInWebhookDedupeKey(
  payload: Record<string, unknown>,
  rawJson?: string,
): string {
  if (typeof payload.notificationId === "string" && payload.notificationId.length > 0) {
    return `linkedin:${payload.notificationId}`;
  }
  if (typeof payload.id === "string" && payload.id.length > 0) {
    return `linkedin:${payload.id}`;
  }
  if (typeof payload.entityUrn === "string" && payload.entityUrn.length > 0) {
    const timestamp = payload.timestamp ?? payload.modifiedAt ?? "";
    return `linkedin:${payload.entityUrn}:${timestamp}`;
  }
  const content = rawJson ?? JSON.stringify(payload);
  const hash = createHmac("sha256", "xlrrank-dedupe").update(content).digest("hex").slice(0, 32);
  return `linkedin:hash:${hash}`;
}

export function encodeLinkedInCursor(cursor: { start: number; count: number; hasMore?: boolean }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeLinkedInCursor(raw?: string): { start: number; count: number; hasMore?: boolean } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed && typeof parsed.start === "number" && typeof parsed.count === "number") {
      return parsed;
    }
  } catch {
    // Ignore malformed cursor
  }
  return null;
}
