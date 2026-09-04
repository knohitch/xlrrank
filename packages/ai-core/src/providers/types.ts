export type ProviderStatus =
  | "connected"
  | "disconnected"
  | "authentication_expired"
  | "rate_limited"
  | "degraded"
  | "unavailable";

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeout?: number;
  protocol?: string;
  metadata?: Record<string, unknown>;
}

export interface AiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TextGenerationRequest {
  model: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  tools?: ToolDefinition[];
}

export interface TextGenerationResponse {
  content: string;
  model: string;
  usage: UsageInfo;
  finishReason: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface StructuredRequest {
  model: string;
  messages: AiMessage[];
  schema: Record<string, unknown>;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface StructuredResponse {
  data: unknown;
  model: string;
  usage: UsageInfo;
  rawContent: string;
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  dimensions?: number;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage: UsageInfo;
}

export interface StreamChunk {
  delta: string;
  finished: boolean;
  model?: string;
  usage?: Partial<UsageInfo>;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderHealthCheck {
  healthy: boolean;
  latencyMs: number;
  error?: string;
  checkedAt: string;
}
