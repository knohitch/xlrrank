import type { AiCapability } from "../capabilities.js";
import type {
  ProviderConfig,
  ProviderStatus,
  TextGenerationRequest,
  TextGenerationResponse,
  StructuredRequest,
  StructuredResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  StreamChunk,
  ProviderHealthCheck,
  AiMessage,
  UsageInfo,
} from "./types.js";
import type { AiModelDescriptor, AiProviderManifest } from "../manifest.js";
import { AiProviderError, AuthenticationError, RateLimitError, ProviderUnavailableError } from "./errors.js";

export abstract class BaseAiProvider {
  protected config: ProviderConfig = {};
  protected status: ProviderStatus = "disconnected";
  protected abstract manifest: AiProviderManifest;

  getManifest(): AiProviderManifest {
    return this.manifest;
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  getCapabilities(): AiCapability[] {
    return this.manifest.capabilities;
  }

  configure(config: ProviderConfig): void {
    this.config = config;
    if (config.apiKey || config.baseUrl) {
      this.status = "degraded";
    }
  }

  async checkHealth(): Promise<boolean> {
    return this.status === "connected" || this.status === "degraded";
  }

  protected async fetchJson<T>(
    url: string,
    options: RequestInit = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = this.config.timeout ?? 60_000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...headers, ...options.headers as Record<string, string> },
        signal: controller.signal,
      });

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      throw new ProviderUnavailableError(
        this.manifest.id,
        (err as Error).message,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  protected async handleErrorResponse(response: Response): Promise<never> {
    const status = response.status;
    let body: string;
    try {
      body = await response.text();
    } catch {
      body = "";
    }

    if (status === 401 || status === 403) {
      throw new AuthenticationError(this.manifest.id);
    }
    if (status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new RateLimitError(
        this.manifest.id,
        retryAfter ? parseInt(retryAfter, 10) : undefined,
      );
    }
    throw new AiProviderError(
      `Provider request failed with HTTP ${status}`,
      this.manifest.id,
      "HTTP_ERROR",
      status >= 500,
      status,
    );
  }

  async generateText(_request: TextGenerationRequest): Promise<TextGenerationResponse> {
    throw new ProviderUnavailableError(this.manifest.id, "text_generation not implemented");
  }

  async generateStructured(_request: StructuredRequest): Promise<StructuredResponse> {
    throw new ProviderUnavailableError(this.manifest.id, "structured_output not implemented");
  }

  async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new ProviderUnavailableError(this.manifest.id, "embeddings not implemented");
  }

  async *streamText(_request: TextGenerationRequest): AsyncGenerator<StreamChunk> {
    throw new ProviderUnavailableError(this.manifest.id, "streaming not implemented");
  }

  async listModels(): Promise<AiModelDescriptor[]> {
    return [];
  }
}
