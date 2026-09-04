import type { AiProviderManifest, AiModelDescriptor } from "../manifest.js";
import type {
  TextGenerationRequest,
  TextGenerationResponse,
  StreamChunk,
  AiMessage,
  UsageInfo,
} from "./types.js";
import { BaseAiProvider } from "./base.js";
import { ModelNotFoundError } from "./errors.js";

interface AnthropicResponse {
  id: string;
  content: Array<{ type: string; text: string }>;
  model: string;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicProvider extends BaseAiProvider {
  protected override manifest: AiProviderManifest = {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    capabilities: ["text_generation", "vision", "tool_calling", "streaming"],
  };

  private getBaseUrl(): string {
    return this.config.baseUrl ?? "https://api.anthropic.com";
  }

  private splitSystem(messages: AiMessage[]): { system?: string; mapped: Array<Record<string, unknown>> } {
    let system: string | undefined;
    const mapped: Array<Record<string, unknown>> = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        system = msg.content;
      } else {
        mapped.push({ role: msg.role, content: msg.content });
      }
    }
    const result: { system?: string; mapped: Array<Record<string, unknown>> } = { mapped };
    if (system !== undefined) result.system = system;
    return result;
  }

  override async generateText(request: TextGenerationRequest): Promise<TextGenerationResponse> {
    const { system, mapped } = this.splitSystem(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: mapped,
      max_tokens: request.maxTokens ?? 4096,
    };
    if (system !== undefined) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stop) body.stop_sequences = request.stop;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey ?? "",
      "anthropic-version": "2023-06-01",
      ...this.config.headers,
    };

    const data = await this.fetchJson<AnthropicResponse>(
      `${this.getBaseUrl()}/v1/messages`,
      { method: "POST", body: JSON.stringify(body), headers },
    );

    const textContent = data.content.find((c) => c.type === "text");
    if (!textContent) throw new ModelNotFoundError(this.manifest.id, request.model);

    return {
      content: textContent.text,
      model: data.model,
      usage: {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
      finishReason: data.stop_reason,
    };
  }

  override async *streamText(request: TextGenerationRequest): AsyncGenerator<StreamChunk> {
    const { system, mapped } = this.splitSystem(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: mapped,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
    };
    if (system !== undefined) body.system = system;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey ?? "",
      "anthropic-version": "2023-06-01",
      ...this.config.headers,
    };

    const response = await fetch(`${this.getBaseUrl()}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) await this.handleErrorResponse(response);

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          try {
            const parsed = JSON.parse(data) as { type?: string; delta?: { text?: string }; stop_reason?: string };
            if (parsed.type === "content_block_delta" && parsed.delta?.text) {
              yield { delta: parsed.delta.text, finished: false };
            }
            if (parsed.type === "message_stop") {
              yield { delta: "", finished: true };
              return;
            }
          } catch { /* skip */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  override async listModels(): Promise<AiModelDescriptor[]> {
    return [
      { providerId: "anthropic", modelId: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
      { providerId: "anthropic", modelId: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
    ];
  }
}
