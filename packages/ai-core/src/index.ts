export { AI_CAPABILITIES } from "./capabilities.js";
export type { AiCapability } from "./capabilities.js";
export type { AiProviderManifest, AiModelDescriptor } from "./manifest.js";
export { AiGateway, aiGateway } from "./gateway.js";

export { BaseAiProvider } from "./providers/base.js";
export { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
export { OpenAIProvider } from "./providers/openai-provider.js";
export { AnthropicProvider } from "./providers/anthropic-provider.js";
export { DeepSeekProvider } from "./providers/deepseek-provider.js";
export { XaiProvider } from "./providers/xai-provider.js";
export { MiMoProvider } from "./providers/mimo-provider.js";
export { OllamaProvider } from "./providers/ollama-provider.js";
export { DemoAiProvider } from "./providers/demo-provider.js";

export {
  AiProviderError,
  AuthenticationError as AiAuthenticationError,
  RateLimitError as AiRateLimitError,
  ModelNotFoundError,
  ContextLimitExceededError,
  SchemaValidationError,
  ProviderUnavailableError,
} from "./providers/errors.js";

export type {
  ProviderConfig,
  ProviderStatus,
  TextGenerationRequest,
  TextGenerationResponse,
  StructuredRequest,
  StructuredResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  StreamChunk,
  AiMessage,
  ToolDefinition,
  UsageInfo,
  ProviderHealthCheck,
} from "./providers/types.js";

export { ModelRegistryService, modelRegistry } from "./registry/model-registry.js";
export type {
  AiProviderCredentialDto,
  AvailableModelQuery,
  CreateAiProviderCredentialInput,
  ModelRegistryRefreshResult,
  RefreshModelRegistryInput,
  RoutingCandidateQuery,
  RoutingCapabilityValidation,
  RoutingModelCandidate,
  RuntimeProviderRequest,
  RuntimeRefreshResult,
} from "./registry/model-registry.js";
export {
  assertSafeProviderRequestUrl,
  fetchProviderUrl,
  validateProviderBaseUrl,
} from "./registry/endpoint-policy.js";
export type { DnsLookup } from "./registry/endpoint-policy.js";
export { ModelProber } from "./registry/model-probe.js";
export type {
  ModelRegistryEntry,
  ModelLifecycleStage,
  ModelProbeResult,
  DiscoveryConfig,
} from "./registry/types.js";

export { TIER_DEFINITIONS, TIER_RANK, tierForTask } from "./router/reasoning-tiers.js";
export type { TierDefinition } from "./router/reasoning-tiers.js";
export { estimateComplexity } from "./router/complexity-estimator.js";
export type { ComplexitySignal, ComplexityEstimate } from "./router/complexity-estimator.js";
export { AiRouter } from "./router/ai-router.js";
export type {
  RoutingAttemptEvidence,
  RoutingDecision,
  RoutingExecutionEvidence,
  RoutingExecutionKind,
  RoutingExecutionResult,
  RoutingModeWeights,
  RoutingMode,
  RoutingOutcomeStatus,
  RoutingPolicy,
  RoutingPolicyProvider,
  RoutingPolicyTierRule,
  RoutingRequest,
  RuntimeProviderResolver,
  StructuredOutputRequirement,
} from "./router/ai-router.js";
export {
  STRUCTURAL_ROUTING_POLICY,
  loadRoutingPolicyFromEnv,
  resolveRoutingPolicy,
  validateRoutingPolicy,
} from "./router/ai-router.js";
export {
  AiExecutionGovernanceError,
  STRUCTURAL_AI_EXECUTION_LIMITS,
  buildUsageAccounting,
  governedEmbeddingRequest,
  governedStructuredRequest,
  governedTextRequest,
  resolveAiExecutionLimits,
  validateAiExecutionLimits,
} from "./execution-governance.js";
export type {
  AiExecutionLimits,
  AiUsageAccounting,
} from "./execution-governance.js";

export {
  languageGuard,
  detectLanguage,
  configureLanguagePolicy,
  DEFAULT_LANGUAGE_POLICY,
} from "./language-guard.js";
export type {
  SupportedLanguage,
  LanguagePolicy,
  LanguageDetectionResult,
  LanguageGuardResult,
} from "./language-guard.js";
