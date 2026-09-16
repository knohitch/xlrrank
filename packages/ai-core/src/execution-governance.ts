import type { AiMessage, EmbeddingRequest, StructuredRequest, TextGenerationRequest, UsageInfo } from "./providers/types.js";

export interface AiExecutionLimits {
  maxMessages: number;
  maxMessageCharacters: number;
  maxInputCharacters: number;
  maxEmbeddingInputs: number;
  maxSchemaCharacters: number;
  maxToolDefinitions: number;
  maxToolParameterCharacters: number;
  maxOutputTokens: number;
  maxModelInvocations: number;
}

export interface AiUsageAccounting {
  source: "PROVIDER_REPORTED" | "UNKNOWN";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedInputCharacters: number;
  outputTokenLimit?: number;
}

export class AiExecutionGovernanceError extends Error {
  readonly code = "AI_EXECUTION_LIMIT_EXCEEDED";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "AiExecutionGovernanceError";
  }
}

export const STRUCTURAL_AI_EXECUTION_LIMITS: AiExecutionLimits = {
  maxMessages: 32,
  maxMessageCharacters: 16_000,
  maxInputCharacters: 32_000,
  maxEmbeddingInputs: 64,
  maxSchemaCharacters: 24_000,
  maxToolDefinitions: 16,
  maxToolParameterCharacters: 16_000,
  maxOutputTokens: 1_024,
  maxModelInvocations: 8,
};

export function resolveAiExecutionLimits(
  override: Partial<AiExecutionLimits> = {},
  base: AiExecutionLimits = STRUCTURAL_AI_EXECUTION_LIMITS,
): AiExecutionLimits {
  return validateAiExecutionLimits({ ...base, ...override });
}

export function validateAiExecutionLimits(limits: AiExecutionLimits): AiExecutionLimits {
  for (const key of Object.keys(STRUCTURAL_AI_EXECUTION_LIMITS) as Array<keyof AiExecutionLimits>) {
    const value = limits[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`AI execution limit '${key}' must be a positive integer`);
    }
  }
  return limits;
}

export function governedTextRequest(request: TextGenerationRequest, limits: AiExecutionLimits): TextGenerationRequest {
  validateMessages(request.messages, limits);
  validateTools(request.tools, limits);
  return { ...request, maxTokens: boundedOutputTokens(request.maxTokens, limits) };
}

export function governedStructuredRequest(request: StructuredRequest, limits: AiExecutionLimits): StructuredRequest {
  validateMessages(request.messages, limits);
  validateJsonCharacters(request.schema, limits.maxSchemaCharacters, "structured output schema");
  return { ...request, maxTokens: boundedOutputTokens(request.maxTokens, limits) };
}

export function governedEmbeddingRequest(request: EmbeddingRequest, limits: AiExecutionLimits): EmbeddingRequest {
  const inputs = Array.isArray(request.input) ? request.input : [request.input];
  if (inputs.length > limits.maxEmbeddingInputs) {
    throw new AiExecutionGovernanceError(`Embedding input count ${inputs.length} exceeds configured limit ${limits.maxEmbeddingInputs}`);
  }
  for (const input of inputs) {
    if (input.length > limits.maxMessageCharacters) {
      throw new AiExecutionGovernanceError("Single embedding input exceeds configured character limit");
    }
  }
  const total = inputs.reduce((sum, input) => sum + input.length, 0);
  if (total > limits.maxInputCharacters) {
    throw new AiExecutionGovernanceError(`Embedding input size ${total} exceeds configured limit ${limits.maxInputCharacters}`);
  }
  return request;
}

export function buildUsageAccounting(input: {
  usage?: UsageInfo | undefined;
  messages?: AiMessage[];
  embeddingInput?: string | string[];
  outputTokenLimit?: number | undefined;
}): AiUsageAccounting {
  const estimatedInputCharacters = input.messages
    ? countMessageCharacters(input.messages)
    : countEmbeddingCharacters(input.embeddingInput ?? "");
  if (!input.usage) {
    return {
      source: "UNKNOWN",
      estimatedInputCharacters,
      ...(input.outputTokenLimit !== undefined ? { outputTokenLimit: input.outputTokenLimit } : {}),
    };
  }
  return {
    source: "PROVIDER_REPORTED",
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    totalTokens: input.usage.totalTokens,
    estimatedInputCharacters,
    ...(input.outputTokenLimit !== undefined ? { outputTokenLimit: input.outputTokenLimit } : {}),
  };
}

export function countMessageCharacters(messages: AiMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

export function countEmbeddingCharacters(input: string | string[]): number {
  return (Array.isArray(input) ? input : [input]).reduce((sum, item) => sum + item.length, 0);
}

function validateMessages(messages: AiMessage[], limits: AiExecutionLimits): void {
  if (messages.length > limits.maxMessages) {
    throw new AiExecutionGovernanceError(`Message count ${messages.length} exceeds configured limit ${limits.maxMessages}`);
  }
  for (const message of messages) {
    if (message.content.length > limits.maxMessageCharacters) {
      throw new AiExecutionGovernanceError("Single message exceeds configured character limit");
    }
  }
  const total = countMessageCharacters(messages);
  if (total > limits.maxInputCharacters) {
    throw new AiExecutionGovernanceError(`Message context size ${total} exceeds configured limit ${limits.maxInputCharacters}`);
  }
}

function validateTools(tools: TextGenerationRequest["tools"], limits: AiExecutionLimits): void {
  if (!tools) return;
  if (tools.length > limits.maxToolDefinitions) {
    throw new AiExecutionGovernanceError(`Tool definition count ${tools.length} exceeds configured limit ${limits.maxToolDefinitions}`);
  }
  for (const tool of tools) {
    validateJsonCharacters(tool.parameters, limits.maxToolParameterCharacters, `tool '${tool.name}' parameters`);
  }
}

function validateJsonCharacters(value: unknown, maxCharacters: number, label: string): void {
  const serialized = JSON.stringify(value);
  if (serialized.length > maxCharacters) {
    throw new AiExecutionGovernanceError(`${label} size ${serialized.length} exceeds configured limit ${maxCharacters}`);
  }
}

function boundedOutputTokens(requested: number | undefined, limits: AiExecutionLimits): number {
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested <= 0) {
      throw new AiExecutionGovernanceError("Requested output token limit must be a positive integer");
    }
    if (requested > limits.maxOutputTokens) {
      throw new AiExecutionGovernanceError(`Requested output token limit ${requested} exceeds configured limit ${limits.maxOutputTokens}`);
    }
    return requested;
  }
  return limits.maxOutputTokens;
}
