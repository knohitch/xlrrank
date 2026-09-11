import type { BaseAiProvider } from "../providers/base.js";
import type { ModelProbeResult } from "./types.js";

export class ModelProber {
  async probe(
    provider: BaseAiProvider,
    modelId: string,
    capabilities: string[] = [],
    options: { timeoutMs?: number } = {},
  ): Promise<ModelProbeResult[]> {
    const results: ModelProbeResult[] = [];
    const requested = new Set(capabilities);
    const timeoutMs = options.timeoutMs ?? 10_000;

    if (requested.has("text_generation") || requested.has("reasoning") || requested.has("tool_calling")) {
      results.push(await this.withTimeout(this.probeTextGeneration(provider, modelId), timeoutMs, "text_generation"));
    }
    if (requested.has("structured_output")) {
      results.push(await this.withTimeout(this.probeStructuredOutput(provider, modelId), timeoutMs, "structured_output"));
    }
    if (requested.has("streaming")) {
      results.push(await this.withTimeout(this.probeStreaming(provider, modelId), timeoutMs, "streaming"));
    }
    if (requested.has("embeddings")) {
      results.push(await this.withTimeout(this.probeEmbeddings(provider, modelId), timeoutMs, "embeddings"));
    }

    return results;
  }

  private async withTimeout(
    probe: Promise<ModelProbeResult>,
    timeoutMs: number,
    capability: string,
  ): Promise<ModelProbeResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        probe,
        new Promise<ModelProbeResult>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              capability,
              quality: 0,
              latencyMs: timeoutMs,
              success: false,
              error: "Probe timed out",
            });
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async probeTextGeneration(
    provider: BaseAiProvider,
    modelId: string,
  ): Promise<ModelProbeResult> {
    const start = Date.now();
    try {
      const response = await provider.generateText({
        model: modelId,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        maxTokens: 10,
        temperature: 0,
      });
      return {
        capability: "text_generation",
        quality: response.content.length > 0 ? 90 : 0,
        latencyMs: Date.now() - start,
        success: true,
      };
    } catch (err) {
      return {
        capability: "text_generation",
        quality: 0,
        latencyMs: Date.now() - start,
        success: false,
        error: (err as Error).message,
      };
    }
  }

  private async probeStructuredOutput(
    provider: BaseAiProvider,
    modelId: string,
  ): Promise<ModelProbeResult> {
    const start = Date.now();
    try {
      const response = await provider.generateStructured({
        model: modelId,
        messages: [{ role: "user", content: 'Return JSON: {"status": "ok"}' }],
        schema: {
          type: "object",
          properties: { status: { type: "string" } },
          required: ["status"],
        },
      });
      const data = response.data as Record<string, unknown>;
      return {
        capability: "structured_output",
        quality: data?.status === "ok" ? 95 : 50,
        latencyMs: Date.now() - start,
        success: true,
      };
    } catch (err) {
      return {
        capability: "structured_output",
        quality: 0,
        latencyMs: Date.now() - start,
        success: false,
        error: (err as Error).message,
      };
    }
  }

  private async probeStreaming(
    provider: BaseAiProvider,
    modelId: string,
  ): Promise<ModelProbeResult> {
    const start = Date.now();
    try {
      let received = false;
      for await (const chunk of provider.streamText({
        model: modelId,
        messages: [{ role: "user", content: "Say hello" }],
        maxTokens: 10,
      })) {
        if (chunk.delta.length > 0) received = true;
        if (chunk.finished) break;
      }
      return {
        capability: "streaming",
        quality: received ? 90 : 0,
        latencyMs: Date.now() - start,
        success: true,
      };
    } catch (err) {
      return {
        capability: "streaming",
        quality: 0,
        latencyMs: Date.now() - start,
        success: false,
        error: (err as Error).message,
      };
    }
  }

  private async probeEmbeddings(
    provider: BaseAiProvider,
    modelId: string,
  ): Promise<ModelProbeResult> {
    const start = Date.now();
    try {
      const response = await provider.generateEmbeddings({
        model: modelId,
        input: "ping",
      });
      return {
        capability: "embeddings",
        quality: response.embeddings.length > 0 ? 90 : 0,
        latencyMs: Date.now() - start,
        success: response.embeddings.length > 0,
      };
    } catch (err) {
      return {
        capability: "embeddings",
        quality: 0,
        latencyMs: Date.now() - start,
        success: false,
        error: (err as Error).message,
      };
    }
  }
}
