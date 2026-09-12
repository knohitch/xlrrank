import type { AiProviderManifest, AiModelDescriptor } from "../manifest.js";
import type { AiCapability } from "../capabilities.js";
import type {
  TextGenerationRequest,
  TextGenerationResponse,
  StructuredRequest,
  StructuredResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  StreamChunk,
  AiMessage,
  UsageInfo,
} from "./types.js";
import { fetchProviderUrl, type DnsLookup } from "../registry/endpoint-policy.js";
import { BaseAiProvider } from "./base.js";
import { AiProviderError, ModelNotFoundError, SchemaValidationError } from "./errors.js";

interface OpenAIChatResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
}

interface OpenAIModelsResponse {
  data: Array<{
    id: string;
    object: string;
    name?: string;
    version?: string;
    fingerprint?: string;
    context_length?: number;
    max_output_tokens?: number;
    capabilities?: AiCapability[];
  }>;
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { prompt_tokens: number; total_tokens: number };
  model: string;
}

export class OpenAICompatibleProvider extends BaseAiProvider {
  protected override manifest: AiProviderManifest;

  constructor(id: string, name: string, capabilities?: AiCapability[]) {
    super();
    this.manifest = {
      id,
      name,
      protocol: "openai-compatible",
      capabilities: capabilities ?? [
        "text_generation",
        "structured_output",
        "tool_calling",
        "streaming",
      ],
    };
  }

  private getBaseUrl(): string {
    return this.config.baseUrl ?? "https://api.openai.com/v1";
  }

  private mapMessages(messages: AiMessage[]): Array<Record<string, unknown>> {
    return messages.map((m) => {
      const msg: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.name) msg.name = m.name;
      if (m.toolCallId) msg.tool_call_id = m.toolCallId;
      return msg;
    });
  }

  override async generateText(request: TextGenerationRequest): Promise<TextGenerationResponse> {
    this.requireOutputLimit(request.maxTokens);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: this.mapMessages(request.messages),
    };
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stop) body.stop = request.stop;
    if (request.tools) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const data = await this.fetchJson<OpenAIChatResponse>(
      `${this.getBaseUrl()}/chat/completions`,
      {
        method: "POST",
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    const choice = data.choices[0];
    if (!choice) throw new ModelNotFoundError(this.manifest.id, request.model);

    const result: TextGenerationResponse = {
      content: choice.message.content ?? "",
      model: data.model,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      finishReason: choice.finish_reason,
    };
    if (choice.message.tool_calls) {
      result.toolCalls = choice.message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
    }
    return result;
  }

  override async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.requireOutputLimit(request.maxTokens);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: this.mapMessages(request.messages),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: request.schemaName ?? "response",
          schema: request.schema,
        },
      },
    };
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const data = await this.fetchJson<OpenAIChatResponse>(
      `${this.getBaseUrl()}/chat/completions`,
      {
        method: "POST",
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    const choice = data.choices[0];
    if (!choice) throw new ModelNotFoundError(this.manifest.id, request.model);

    const rawContent = choice.message.content ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      throw new SchemaValidationError(this.manifest.id, "Response is not valid JSON");
    }

    return {
      data: parsed,
      model: data.model,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      rawContent,
    };
  }

  override async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const body = {
      model: request.model,
      input: Array.isArray(request.input) ? request.input : [request.input],
      ...(request.dimensions ? { dimensions: request.dimensions } : {}),
    };

    const data = await this.fetchJson<OpenAIEmbeddingResponse>(
      `${this.getBaseUrl()}/embeddings`,
      {
        method: "POST",
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    return {
      embeddings: data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
      model: data.model,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: 0,
        totalTokens: data.usage.total_tokens,
      },
    };
  }

  override async *streamText(request: TextGenerationRequest): AsyncGenerator<StreamChunk> {
    this.requireOutputLimit(request.maxTokens);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: this.mapMessages(request.messages),
      stream: true,
    };
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const url = `${this.getBaseUrl()}/chat/completions`;
    const response = await fetchProviderUrl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      ...(request.signal ? { signal: request.signal } : {}),
      allowPrivateNetwork: this.config.metadata?.allowPrivateNetwork === true,
      lookup: this.config.metadata?.dnsLookup as DnsLookup | undefined,
    });

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

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
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            yield { delta: "", finished: true };
            return;
          }
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            };
            const delta = parsed.choices?.[0]?.delta?.content ?? "";
            const finished = parsed.choices?.[0]?.finish_reason != null;
            yield { delta, finished };
          } catch {
            // skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  override async listModels(): Promise<AiModelDescriptor[]> {
    const data = await this.fetchJson<OpenAIModelsResponse>(
      `${this.getBaseUrl()}/models`,
    );
    return data.data.map((m) => {
      const descriptor: AiModelDescriptor = {
        providerId: this.manifest.id,
        modelId: m.id,
        displayName: m.name ?? m.id,
      };
      if (m.version !== undefined) descriptor.version = m.version;
      if (m.capabilities !== undefined) descriptor.capabilities = m.capabilities;
      if (m.context_length !== undefined) descriptor.contextLimit = m.context_length;
      return descriptor;
    });
  }

  private requireOutputLimit(maxTokens: number | undefined): void {
    if (!Number.isInteger(maxTokens) || (maxTokens ?? 0) <= 0) {
      throw new AiProviderError(
        "AI output token limit is required for provider execution",
        this.manifest.id,
        "OUTPUT_LIMIT_REQUIRED",
        false,
        400,
      );
    }
  }
}
