import { OpenAICompatibleProvider } from "./openai-compatible.js";

export class OllamaProvider extends OpenAICompatibleProvider {
  constructor() {
    super("ollama", "Ollama (Local)", [
      "text_generation",
      "structured_output",
      "embeddings",
      "streaming",
    ]);
  }
}
