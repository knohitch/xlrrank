import { OpenAICompatibleProvider } from "./openai-compatible.js";

export class MiMoProvider extends OpenAICompatibleProvider {
  constructor() {
    super("mimo", "Xiaomi MiMo", [
      "text_generation",
      "reasoning",
      "structured_output",
      "streaming",
    ]);
  }
}
