import type { AiCapability } from "../capabilities.js";
import { fetchProviderUrl, type DnsLookup } from "./endpoint-policy.js";
import { AiProviderError, AuthenticationError, ProviderUnavailableError, RateLimitError } from "../providers/errors.js";

export type ProviderHealthStatus =
  | "CONFIGURATION_MISSING"
  | "AUTHENTICATION_FAILED"
  | "RATE_LIMITED"
  | "TEMPORARILY_UNAVAILABLE"
  | "HEALTHY"
  | "DEGRADED";

export interface RuntimeCredential {
  credentialId?: string;
  apiKey?: string;
}

export interface ProviderRuntime {
  providerId: string;
  slug: string;
  name: string;
  protocol: string;
  baseUrl: string;
  headers?: Record<string, string>;
  credential: RuntimeCredential;
  timeoutMs: number;
  allowPrivateNetwork?: boolean;
  dnsLookup?: DnsLookup;
}

export interface DiscoveredModel {
  providerModelId: string;
  displayName?: string;
  version?: string;
  fingerprint?: string;
  contextLimit?: number;
  outputLimit?: number;
  advertisedCapabilities: AiCapability[];
  providerMetadata: Record<string, unknown>;
}

export interface DiscoverySuccess {
  ok: true;
  models: DiscoveredModel[];
  health: ProviderHealthStatus;
}

export interface DiscoveryFailure {
  ok: false;
  health: ProviderHealthStatus;
  retryable: boolean;
  safeError: { code: string; message: string; status?: number };
}

export type DiscoveryResult = DiscoverySuccess | DiscoveryFailure;

export interface ProtocolAdapter {
  protocol: string;
  discover(runtime: ProviderRuntime): Promise<DiscoveryResult>;
}

type JsonObject = Record<string, unknown>;

function authHeaders(runtime: ProviderRuntime): Record<string, string> {
  return runtime.credential.apiKey
    ? { Authorization: `Bearer ${runtime.credential.apiKey}` }
    : {};
}

function normalizeCapabilities(value: unknown): AiCapability[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<AiCapability>([
    "text_generation",
    "reasoning",
    "structured_output",
    "tool_calling",
    "vision",
    "embeddings",
    "streaming",
  ]);
  return value.filter((item): item is AiCapability => typeof item === "string" && allowed.has(item as AiCapability));
}

function mapAnthropicCapability(key: string): AiCapability | null {
  switch (key) {
    case "text_generation":
    case "text":
    case "messages":
      return "text_generation";
    case "structured_outputs":
    case "json_schema":
      return "structured_output";
    case "tool_use":
      return "tool_calling";
    case "thinking":
    case "extended_thinking":
    case "reasoning":
      return "reasoning";
    case "image_input":
    case "vision":
      return "vision";
    default:
      return null;
  }
}

function safeProviderError(error: unknown, providerId: string): DiscoveryFailure {
  if (error instanceof AuthenticationError) {
    return {
      ok: false,
      health: "AUTHENTICATION_FAILED",
      retryable: false,
      safeError: { code: "AUTHENTICATION_FAILED", message: "Provider authentication failed" },
    };
  }
  if (error instanceof RateLimitError) {
    return {
      ok: false,
      health: "RATE_LIMITED",
      retryable: true,
      safeError: { code: "RATE_LIMITED", message: "Provider rate limited model discovery" },
    };
  }
  if (error instanceof AiProviderError) {
    const safeError: DiscoveryFailure["safeError"] = {
      code: error.code,
      message: "Provider model discovery failed",
    };
    if (error.statusCode !== undefined) safeError.status = error.statusCode;
    return {
      ok: false,
      health: error.retryable ? "TEMPORARILY_UNAVAILABLE" : "DEGRADED",
      retryable: error.retryable,
      safeError,
    };
  }
  return {
    ok: false,
    health: "TEMPORARILY_UNAVAILABLE",
    retryable: true,
    safeError: {
      code: "PROVIDER_UNAVAILABLE",
      message: error instanceof Error ? error.message.slice(0, 160) : `Provider ${providerId} unavailable`,
    },
  };
}

async function fetchJson<T>(
  runtime: ProviderRuntime,
  path: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  try {
    const url = `${runtime.baseUrl}${path}`;
    const response = await fetchProviderUrl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...authHeaders(runtime),
        ...runtime.headers,
        ...headers,
      },
      redirect: "error",
      signal: controller.signal,
      allowPrivateNetwork: runtime.allowPrivateNetwork === true,
      lookup: runtime.dnsLookup,
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError(runtime.providerId);
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new RateLimitError(runtime.providerId, retryAfter ? Number(retryAfter) : undefined);
    }
    if (!response.ok) {
      throw new AiProviderError(
        `Provider discovery failed with HTTP ${response.status}`,
        runtime.providerId,
        "DISCOVERY_HTTP_ERROR",
        response.status >= 500,
        response.status,
      );
    }
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    throw new ProviderUnavailableError(runtime.providerId, err instanceof Error ? err.message : "fetch failed");
  } finally {
    clearTimeout(timer);
  }
}

export class OpenAICompatibleAdapter implements ProtocolAdapter {
  protocol = "openai-compatible";

  async discover(runtime: ProviderRuntime): Promise<DiscoveryResult> {
    try {
      const data = await fetchJson<{ data?: JsonObject[] }>(runtime, "/models");
      const models = (data.data ?? [])
        .filter((model) => typeof model.id === "string")
        .map((model): DiscoveredModel => {
          const item: DiscoveredModel = {
            providerModelId: String(model.id),
            displayName: typeof model.name === "string" ? model.name : String(model.id),
            advertisedCapabilities: normalizeCapabilities(model.capabilities),
            providerMetadata: {
              object: model.object,
              owner: model.owned_by,
              created: model.created,
              shutdownDate: model.shutdown_date,
            },
          };
          if (typeof model.version === "string") item.version = model.version;
          if (typeof model.fingerprint === "string") item.fingerprint = model.fingerprint;
          if (typeof model.context_length === "number") item.contextLimit = model.context_length;
          if (typeof model.max_output_tokens === "number") item.outputLimit = model.max_output_tokens;
          return item;
        });
      return { ok: true, models, health: "HEALTHY" };
    } catch (err) {
      return safeProviderError(err, runtime.providerId);
    }
  }
}

export class AnthropicAdapter implements ProtocolAdapter {
  protocol = "anthropic";

  async discover(runtime: ProviderRuntime): Promise<DiscoveryResult> {
    try {
      const models: DiscoveredModel[] = [];
      let afterId: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const suffix = afterId ? `?after_id=${encodeURIComponent(afterId)}&limit=100` : "?limit=100";
        const data = await fetchJson<{
          data?: JsonObject[];
          has_more?: boolean;
          last_id?: string;
        }>(runtime, `/v1/models${suffix}`, {
          "x-api-key": runtime.credential.apiKey ?? "",
          "anthropic-version": "2023-06-01",
        });
        for (const model of data.data ?? []) {
          if (typeof model.id !== "string") continue;
          const caps = model.capabilities && typeof model.capabilities === "object"
            ? Object.entries(model.capabilities as JsonObject)
                .filter(([, value]) => Boolean((value as JsonObject | undefined)?.supported))
                .map(([key]) => mapAnthropicCapability(key))
                .filter((capability): capability is AiCapability => Boolean(capability))
            : [];
          const item: DiscoveredModel = {
            providerModelId: model.id,
            displayName: typeof model.display_name === "string" ? model.display_name : model.id,
            advertisedCapabilities: caps,
            providerMetadata: {
              type: model.type,
              createdAt: model.created_at,
              capabilities: model.capabilities,
            },
          };
          if (typeof model.max_input_tokens === "number") item.contextLimit = model.max_input_tokens;
          if (typeof model.max_tokens === "number") item.outputLimit = model.max_tokens;
          models.push(item);
        }
        if (!data.has_more || typeof data.last_id !== "string") break;
        afterId = data.last_id;
      }
      return { ok: true, models, health: "HEALTHY" };
    } catch (err) {
      return safeProviderError(err, runtime.providerId);
    }
  }
}

export class OllamaAdapter implements ProtocolAdapter {
  protocol = "ollama";

  async discover(runtime: ProviderRuntime): Promise<DiscoveryResult> {
    try {
      const data = await fetchJson<{ models?: JsonObject[] }>(runtime, "/api/tags");
      const models = (data.models ?? [])
        .filter((model) => typeof model.model === "string" || typeof model.name === "string")
        .map((model): DiscoveredModel => {
          const modelId = String(model.model ?? model.name);
          const item: DiscoveredModel = {
            providerModelId: modelId,
            displayName: typeof model.name === "string" ? model.name : modelId,
            advertisedCapabilities: normalizeCapabilities(model.capabilities),
            providerMetadata: {
              modifiedAt: model.modified_at,
              size: model.size,
              details: model.details,
            },
          };
          if (typeof model.digest === "string") item.fingerprint = model.digest;
          return item;
        });
      return { ok: true, models, health: "HEALTHY" };
    } catch (err) {
      return safeProviderError(err, runtime.providerId);
    }
  }
}

export class XaiAdapter extends OpenAICompatibleAdapter {
  override protocol = "xai";

  override async discover(runtime: ProviderRuntime): Promise<DiscoveryResult> {
    try {
      const data = await fetchJson<{ models?: JsonObject[] }>(runtime, "/v1/language-models");
      const models = (data.models ?? [])
        .filter((model) => typeof model.id === "string")
        .map((model): DiscoveredModel => {
          const item: DiscoveredModel = {
            providerModelId: String(model.id),
            advertisedCapabilities: normalizeCapabilities(model.capabilities),
            providerMetadata: {
              aliases: model.aliases,
              inputModalities: model.input_modalities,
              outputModalities: model.output_modalities,
              created: model.created,
              owner: model.owned_by,
            },
          };
          if (typeof model.id === "string") item.displayName = model.id;
          if (typeof model.version === "string") item.version = model.version;
          if (typeof model.fingerprint === "string") item.fingerprint = model.fingerprint;
          if (typeof model.max_prompt_length === "number") item.contextLimit = model.max_prompt_length;
          return item;
        });
      return { ok: true, models, health: "HEALTHY" };
    } catch {
      const compatibleRuntime = { ...runtime, baseUrl: runtime.baseUrl.endsWith("/v1") ? runtime.baseUrl : `${runtime.baseUrl}/v1` };
      return super.discover(compatibleRuntime);
    }
  }
}

export function defaultProtocolAdapters(): ProtocolAdapter[] {
  return [
    new OpenAICompatibleAdapter(),
    new AnthropicAdapter(),
    new OllamaAdapter(),
    new XaiAdapter(),
  ];
}
