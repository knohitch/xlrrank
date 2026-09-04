export const AI_CAPABILITIES = [
  "text_generation",
  "reasoning",
  "structured_output",
  "tool_calling",
  "vision",
  "embeddings",
  "streaming",
] as const;

export type AiCapability = (typeof AI_CAPABILITIES)[number];
