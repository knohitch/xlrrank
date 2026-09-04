import { OpenAICompatibleProvider } from "./openai-compatible.js";

export class XaiProvider extends OpenAICompatibleProvider {
  constructor() {
    super("xai", "xAI / Grok", [
      "text_generation",
      "reasoning",
      "structured_output",
      "tool_calling",
      "vision",
      "streaming",
    ]);
  }
}
