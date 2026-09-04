import type { AiProviderManifest, AiModelDescriptor } from "../manifest.js";
import type { AiMessage, TextGenerationRequest, TextGenerationResponse, StructuredRequest, StructuredResponse, EmbeddingRequest, EmbeddingResponse, StreamChunk } from "./types.js";
import { BaseAiProvider } from "./base.js";

export class DemoAiProvider extends BaseAiProvider {
  protected manifest: AiProviderManifest = {
    id: "demo",
    name: "Demo AI Provider",
    protocol: "demo",
    capabilities: ["text_generation", "structured_output", "streaming"],
  };

  constructor() {
    super();
    this.status = "connected";
  }

  override configure(): void {
    this.status = "connected";
  }

  override async checkHealth(): Promise<boolean> {
    return true;
  }

  override async generateText(request: TextGenerationRequest): Promise<TextGenerationResponse> {
    const lastMessage = request.messages[request.messages.length - 1];
    const response = `[DEMO] Response to: "${lastMessage?.content.slice(0, 50) ?? "unknown"}..." — This is demo output. Configure a real AI provider for production use.`;
    return {
      content: response,
      model: "demo-model",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: "stop",
    };
  }

  override async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    return {
      data: { status: "demo", message: "This is demo structured output." },
      model: "demo-model",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      rawContent: '{"status":"demo","message":"This is demo structured output."}',
    };
  }

  override async *streamText(request: TextGenerationRequest): AsyncGenerator<StreamChunk> {
    const words = "[DEMO] This is demo streaming output. Configure a real AI provider.".split(" ");
    for (const word of words) {
      yield { delta: word + " ", finished: false };
    }
    yield { delta: "", finished: true };
  }

  override async listModels(): Promise<AiModelDescriptor[]> {
    return [
      { providerId: "demo", modelId: "demo-model", displayName: "Demo Model (not for production)" },
    ];
  }
}
