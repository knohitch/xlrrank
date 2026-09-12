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
      results.push(await this.withAbort(this.probeTextGeneration.bind(this), provider, modelId, timeoutMs, "text_generation"));
    }
    if (requested.has("structured_output")) {
      results.push(await this.withAbort(this.probeStructuredOutput.bind(this), provider, modelId, timeoutMs, "structured_output"));
    }
    if (requested.has("streaming")) {
      results.push(await this.withAbort(this.probeStreaming.bind(this), provider, modelId, timeoutMs, "streaming"));
    }
    if (requested.has("embeddings")) {
      results.push(await this.withAbort(this.probeEmbeddings.bind(this), provider, modelId, timeoutMs, "embeddings"));
    }

    return results;
  }

  private async withAbort(
    probe: (provider: BaseAiProvider, modelId: string, signal: AbortSignal) => Promise<ModelProbeResult>,
    provider: BaseAiProvider,
    modelId: string,
    timeoutMs: number,
    capability: string,
  ): Promise<ModelProbeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    try {
      return await probe(provider, modelId, controller.signal);
    } catch (err) {
      const timedOut = controller.signal.aborted;
      return {
        capability,
        quality: 0,
        latencyMs: Date.now() - start,
        success: false,
        error: timedOut ? "Probe timed out" : (err as Error).message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async probeTextGeneration(
    provider: BaseAiProvider,
    modelId: string,
    signal: AbortSignal,
  ): Promise<ModelProbeResult> {
    const start = Date.now();
    try {
      const response = await provider.generateText({
        model: modelId,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        maxTokens: 10,
        temperature: 0,
        signal,
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
    signal: AbortSignal,
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
        maxTokens: 25,
        signal,
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
    signal: AbortSignal,
  ): Promise<ModelProbeResult> {
    const start = Date.now();
    try {
      let received = false;
      for await (const chunk of provider.streamText({
        model: modelId,
        messages: [{ role: "user", content: "Say hello" }],
        maxTokens: 10,
        signal,
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
    signal: AbortSignal,
  ): Promise<ModelProbeResult> {
    const start = Date.now();
    try {
      const response = await provider.generateEmbeddings({
        model: modelId,
        input: "ping",
        signal,
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
