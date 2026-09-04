import type { AiCapability } from "./capabilities.js";
import type { AiProviderManifest, AiModelDescriptor } from "./manifest.js";
import type { BaseAiProvider } from "./providers/base.js";
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
} from "./providers/types.js";

export class AiGateway {
  private providers = new Map<string, BaseAiProvider>();

  registerProvider(provider: BaseAiProvider): void {
    const manifest = provider.getManifest();
    this.providers.set(manifest.id, provider);
  }

  getProvider(id: string): BaseAiProvider | undefined {
    return this.providers.get(id);
  }

  listProviders(): Array<{ manifest: AiProviderManifest; status: ProviderStatus }> {
    return [...this.providers.values()].map((p) => ({
      manifest: p.getManifest(),
      status: p.getStatus(),
    }));
  }

  configureProvider(id: string, config: ProviderConfig): void {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Provider '${id}' not registered`);
    provider.configure(config);
  }

  findProviderForCapability(capability: AiCapability): BaseAiProvider | undefined {
    for (const provider of this.providers.values()) {
      if (provider.getCapabilities().includes(capability) && provider.getStatus() === "connected") {
        return provider;
      }
    }
    return undefined;
  }

  async generateText(
    providerId: string,
    request: TextGenerationRequest,
  ): Promise<TextGenerationResponse> {
    const provider = this.requireProvider(providerId);
    return provider.generateText(request);
  }

  async generateStructured(
    providerId: string,
    request: StructuredRequest,
  ): Promise<StructuredResponse> {
    const provider = this.requireProvider(providerId);
    return provider.generateStructured(request);
  }

  async generateEmbeddings(
    providerId: string,
    request: EmbeddingRequest,
  ): Promise<EmbeddingResponse> {
    const provider = this.requireProvider(providerId);
    return provider.generateEmbeddings(request);
  }

  async *streamText(
    providerId: string,
    request: TextGenerationRequest,
  ): AsyncGenerator<StreamChunk> {
    const provider = this.requireProvider(providerId);
    yield* provider.streamText(request);
  }

  async listAllModels(): Promise<AiModelDescriptor[]> {
    const all: AiModelDescriptor[] = [];
    for (const provider of this.providers.values()) {
      try {
        const models = await provider.listModels();
        all.push(...models);
      } catch {
        // provider may be unavailable
      }
    }
    return all;
  }

  async healthCheck(providerId: string): Promise<boolean> {
    const provider = this.providers.get(providerId);
    if (!provider) return false;
    return provider.checkHealth();
  }

  private requireProvider(id: string): BaseAiProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Provider '${id}' not registered`);
    return provider;
  }
}

export const aiGateway = new AiGateway();
