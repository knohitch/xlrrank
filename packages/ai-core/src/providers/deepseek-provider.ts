import { OpenAICompatibleProvider } from "./openai-compatible.js";

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor() {
    super("deepseek", "DeepSeek", [
      "text_generation",
      "reasoning",
      "structured_output",
      "tool_calling",
      "streaming",
    ]);
  }
}
