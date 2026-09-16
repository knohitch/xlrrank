import { createHmac } from "node:crypto";
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

export const META_GRAPH_API_VERSION = "v26.0";
export const META_GRAPH_BASE_URL = "https://graph.facebook.com";
export const META_DIALOG_BASE_URL = "https://www.facebook.com";

export interface MetaHttpClientOptions {
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  connectorId?: string;
}

export interface MetaResponse<T> {
  body: T;
  rateLimit?: RateLimitInfo;
}

export class MetaGraphClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly connectorId: string;

  constructor(options: MetaHttpClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? process.env.META_GRAPH_BASE_URL ?? META_GRAPH_BASE_URL,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.connectorId = options.connectorId ?? "meta";
  }

  async get<T>(
    path: string,
    accessToken: string,
    query?: URLSearchParams,
    options: { appSecret?: string | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<MetaResponse<T>> {
    const url = this.url(path);
    if (query) {
      for (const [key, value] of query) url.searchParams.append(key, value);
    }
    url.searchParams.set("access_token", accessToken);
    if (options.appSecret) {
      url.searchParams.set("appsecret_proof", appSecretProof(accessToken, options.appSecret));
    }
    const init: RequestInit = { method: "GET" };
    if (options.signal) init.signal = options.signal;
    return this.request<T>(url, init);
  }

  async postForm<T>(
    path: string,
    form: URLSearchParams,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<MetaResponse<T>> {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    };
    if (options.signal) init.signal = options.signal;
    return this.request<T>(this.url(path), init);
  }

  private url(path: string): URL {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return new URL(`${this.baseUrl}/${META_GRAPH_API_VERSION}${normalized}`);
  }

  private async request<T>(url: URL, init: RequestInit): Promise<MetaResponse<T>> {
    const response = await this.fetchImpl(url, init);
    const rateLimit = metaRateLimitFrom(response);
    const body = await readJson(response, this.connectorId);
    if (!response.ok) throw mapMetaError(this.connectorId, response.status, body, rateLimit);
    if (body === null || typeof body !== "object") {
      throw new MalformedProviderResponseError(this.connectorId, "Meta response was not an object");
    }
    return rateLimit ? { body: body as T, rateLimit } : { body: body as T };
  }
}

export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken, "utf8").digest("hex");
}

export function encodeMetaCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeMetaCursor(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function metaRateLimitFrom(response: Response): RateLimitInfo | undefined {
  const retryAfter = response.headers.get("retry-after");
  const appUsage = response.headers.get("x-app-usage");
  const pageUsage = response.headers.get("x-page-usage");
  const businessUsage = response.headers.get("x-business-use-case-usage");
  if (retryAfter === null && appUsage === null && pageUsage === null && businessUsage === null) {
    return undefined;
  }
  const retryAfterSeconds = retryAfter === null ? undefined : Number.parseInt(retryAfter, 10);
  return {
    remaining: retryAfterSeconds === undefined ? 1 : 0,
    retryAfter:
      retryAfterSeconds === undefined || Number.isNaN(retryAfterSeconds)
        ? undefined
        : retryAfterSeconds,
    providerMetadata: {
      headers: {
        hasAppUsage: appUsage !== null,
        hasPageUsage: pageUsage !== null,
        hasBusinessUseCaseUsage: businessUsage !== null,
      },
    },
  };
}

async function readJson(response: Response, connectorId: string): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MalformedProviderResponseError(connectorId, "Meta response was not valid JSON");
  }
}

function mapMetaError(
  connectorId: string,
  status: number,
  body: unknown,
  rateLimit?: RateLimitInfo,
): Error {
  const error = body && typeof body === "object" ? (body as { error?: MetaProblem }).error : undefined;
  const code = typeof error?.code === "number" ? error.code : undefined;
  const subcode = typeof error?.error_subcode === "number" ? error.error_subcode : undefined;
  const message = typeof error?.message === "string" ? error.message : `Meta provider status ${status}`;
  if (status === 401 || code === 190 || subcode === 463 || subcode === 467) {
    return new AuthenticationError(connectorId, "Meta authorization is invalid or expired");
  }
  if (status === 403 || code === 10 || code === 200) {
    return new AuthorizationError(connectorId, "Meta authorization does not permit this operation");
  }
  if (status === 429 || code === 4 || code === 17 || code === 613) {
    return new RateLimitError(connectorId, rateLimit?.retryAfter ?? 60);
  }
  if (status >= 500 || code === 1 || code === 2) {
    return new TemporaryProviderError(connectorId, message);
  }
  if (status >= 400 && error?.type === "OAuthException" && code === 101) {
    return new ConnectorConfigurationError(connectorId, "Meta provider app credentials are invalid");
  }
  return new PermanentProviderError(connectorId, message);
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConnectorConfigurationError("meta", "Meta Graph base URL must be http or https");
  }
  return url.toString().replace(/\/+$/, "");
}

interface MetaProblem {
  message?: unknown;
  type?: unknown;
  code?: unknown;
  error_subcode?: unknown;
}
