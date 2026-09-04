import { OpenAICompatibleProvider } from "./openai-compatible.js";

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor() {
    super("openai", "OpenAI", [
      "text_generation",
      "reasoning",
      "structured_output",
      "tool_calling",
      "vision",
      "embeddings",
      "streaming",
    ]);
  }
}
