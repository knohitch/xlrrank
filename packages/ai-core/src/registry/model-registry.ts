import { randomUUID } from "node:crypto";
import { getEnv } from "@xlrrank/config";
import { getPool } from "@xlrrank/database";
import {
  aiProviderCredentialAssociatedData,
  decryptSecret,
  encryptSecret,
} from "@xlrrank/shared";
import type { AiCapability } from "../capabilities.js";
import { AnthropicProvider } from "../providers/anthropic-provider.js";
import { BaseAiProvider } from "../providers/base.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import type { ModelLifecycleStage, ModelProbeResult, ModelRegistryEntry } from "./types.js";
import { validateProviderBaseUrl, type DnsLookup } from "./endpoint-policy.js";
import { ModelProber } from "./model-probe.js";
import {
  type DiscoveredModel,
  type DiscoveryFailure,
  type DiscoveryResult,
  type ProtocolAdapter,
  defaultProtocolAdapters,
} from "./protocol-adapters.js";

interface QueryResult<T> {
  rows: T[];
  rowCount?: number | null;
}

interface DbExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  connect?(): Promise<TransactionClient>;
}

interface TransactionClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
}

interface ProviderRow {
  id: string;
  name: string;
  slug: string;
  protocol: string;
  base_url: string | null;
  api_key_encrypted: string | null;
  enabled: boolean;
  config: Record<string, unknown> | null;
}

interface CredentialRow {
  id: string;
  provider_id: string;
  scope_kind: string;
  scope_id: string | null;
  label: string;
  credentials_encrypted: string;
}

interface ModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string | null;
  version: string | null;
  fingerprint: string | null;
  lifecycle_stage: ModelLifecycleStage;
  capabilities: unknown;
  context_limit: number | null;
  health: unknown;
  last_seen_at: Date | null;
  last_probed_at: Date | null;
  created_at: Date;
}

export interface CreateAiProviderCredentialInput {
  providerId: string;
  apiKey: string;
  scopeKind?: "SYSTEM" | "USER" | "ORGANIZATION";
  scopeId?: string | null;
  label?: string;
}

export interface AiProviderCredentialDto {
  id: string;
  providerId: string;
  scopeKind: string;
  scopeId: string | null;
  label: string;
}

export interface RefreshModelRegistryInput {
  providerId?: string;
  credentialId?: string;
  reason?: "SCHEDULED" | "MANUAL" | "RETRY";
  maxProviders?: number;
  maxModelsPerProvider?: number;
  maxProbeModels?: number;
}

export interface RuntimeRefreshResult {
  providerId: string;
  credentialId?: string;
  runtimeKey: string;
  discovery: DiscoveryResult;
  persistedModels: number;
  probedModels: number;
}

export interface ModelRegistryRefreshResult {
  runtimes: RuntimeRefreshResult[];
}

export interface AvailableModelQuery {
  providerId?: string;
  credentialId?: string;
  lifecycleStage?: ModelLifecycleStage;
  capability?: AiCapability;
  scopeId?: string;
}

export interface RoutingCandidateQuery {
  providerId?: string;
  credentialId?: string;
  scopeId?: string;
  capabilities: AiCapability[];
  lifecycleStages?: ModelLifecycleStage[];
}

export interface RoutingCapabilityValidation {
  capability: AiCapability;
  quality: number | null;
  latencyMs: number | null;
  checkedAt: string;
}

export interface RoutingModelCandidate extends ModelRegistryEntry {
  modelUuid: string;
  runtimeKey: string;
  credentialId: string | null;
  availabilityStatus: string;
  availabilityHealth: unknown;
  providerStatus: string;
  providerHealth: unknown;
  credentialStatus: string | null;
  credentialScopeKind: string | null;
  credentialScopeId: string | null;
  validations: RoutingCapabilityValidation[];
  validationQuality: number | null;
  validationLatencyMs: number | null;
}

interface RuntimeContext {
  provider: ProviderRow;
  credential?: CredentialRow;
  runtimeKey: string;
  apiKey?: string;
  baseUrl: string;
  allowPrivateNetwork: boolean;
  dnsLookup?: DnsLookup;
}

function configBoolean(config: Record<string, unknown> | null, key: string): boolean {
  return config?.[key] === true;
}

function providerCapabilities(model: DiscoveredModel): AiCapability[] {
  return [...new Set(model.advertisedCapabilities)];
}

function configCapabilities(config: Record<string, unknown> | null): AiCapability[] {
  const raw = config?.probeCapabilities;
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<AiCapability>([
    "text_generation",
    "reasoning",
    "structured_output",
    "tool_calling",
    "vision",
    "embeddings",
    "streaming",
  ]);
  return raw.filter((item): item is AiCapability => typeof item === "string" && allowed.has(item as AiCapability));
}

function defaultProbeCapabilities(protocol: string): AiCapability[] {
  if (protocol === "anthropic") return ["text_generation", "structured_output", "reasoning", "vision"];
  if (protocol === "ollama") return ["text_generation", "embeddings"];
  return ["text_generation", "structured_output", "embeddings"];
}

function runtimeKey(credential?: CredentialRow): string {
  return credential ? `credential:${credential.id}` : "system";
}

function dateIso(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : value;
}

function numberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRoutingValidations(value: unknown): RoutingCapabilityValidation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.capability !== "string") return [];
    return [{
      capability: record.capability as AiCapability,
      quality: numberOrNull(record.quality as string | number | null | undefined),
      latencyMs: numberOrNull(record.latencyMs as string | number | null | undefined),
      checkedAt: dateIso(record.checkedAt as string | Date | null | undefined),
    }];
  });
}

export class ModelRegistryService {
  private readonly prober = new ModelProber();
  private readonly adapters = new Map<string, ProtocolAdapter>();

  constructor(
    private readonly db: DbExecutor = getPool() as unknown as DbExecutor,
    adapters: ProtocolAdapter[] = defaultProtocolAdapters(),
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.protocol, adapter);
    const compatible = this.adapters.get("openai-compatible");
    if (compatible) {
      this.adapters.set("openai", compatible);
      this.adapters.set("deepseek", compatible);
    }
  }

  async createCredential(input: CreateAiProviderCredentialInput): Promise<AiProviderCredentialDto> {
    const id = randomUUID();
    const scopeKind = input.scopeKind ?? "SYSTEM";
    const scopeId = input.scopeId ?? null;
    const encrypted = encryptSecret(
      input.apiKey,
      undefined,
      aiProviderCredentialAssociatedData({
        credentialId: id,
        providerId: input.providerId,
        scopeKind,
        scopeId,
      }),
    );
    const result = await this.db.query<CredentialRow>(
      `
      INSERT INTO ai_provider_credentials
        (id, provider_id, scope_kind, scope_id, label, credentials_encrypted)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, provider_id, scope_kind, scope_id, label, credentials_encrypted
      `,
      [id, input.providerId, scopeKind, scopeId, input.label ?? "default", encrypted],
    );
    const row = result.rows[0];
    if (!row) throw new Error("AI provider credential was not created");
    return {
      id: row.id,
      providerId: row.provider_id,
      scopeKind: row.scope_kind,
      scopeId: row.scope_id,
      label: row.label,
    };
  }

  async refresh(input: RefreshModelRegistryInput = {}): Promise<ModelRegistryRefreshResult> {
    const env = getEnv();
    const providers = await this.loadProviders(
      input.providerId,
      input.maxProviders ?? env.AI_MODEL_DISCOVERY_MAX_PROVIDERS_PER_RUN,
    );
    const runtimes: RuntimeRefreshResult[] = [];
    for (const provider of providers) {
      const credentials = input.credentialId
        ? [await this.loadCredential(input.credentialId, provider.id)]
        : await this.loadCredentials(provider.id);
      const runtimeCredentials = credentials.length > 0 ? credentials : [undefined];
      for (const credential of runtimeCredentials) {
        const ctx = this.resolveRuntime(provider, credential);
        runtimes.push(
          await this.refreshRuntime(ctx, {
            maxModelsPerProvider: input.maxModelsPerProvider ?? env.AI_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER,
            maxProbeModels: input.maxProbeModels ?? env.AI_MODEL_PROBE_MAX_MODELS_PER_RUN,
            probeTimeoutMs: env.AI_MODEL_PROBE_TIMEOUT_MS,
          }),
        );
      }
    }
    return { runtimes };
  }

  async listAvailableModels(query: AvailableModelQuery = {}): Promise<ModelRegistryEntry[]> {
    const params: unknown[] = [];
    const clauses = ["ama.status = 'AVAILABLE'"];
    if (query.providerId) {
      params.push(query.providerId);
      clauses.push(`am.provider_id = $${params.length}`);
    }
    if (query.credentialId) {
      params.push(`credential:${query.credentialId}`);
      clauses.push(`ama.runtime_key = $${params.length}`);
    }
    if (query.lifecycleStage) {
      params.push(query.lifecycleStage);
      clauses.push(`am.lifecycle_stage = $${params.length}`);
    }
    if (query.capability) {
      params.push(query.capability);
      clauses.push(`EXISTS (
        SELECT 1 FROM ai_model_capability_validations acv
        WHERE acv.model_id = am.id
          AND acv.runtime_key = ama.runtime_key
          AND acv.capability = $${params.length}
          AND acv.status = 'VALIDATED'
      )`);
    }
    if (query.scopeId) {
      params.push(query.scopeId);
      clauses.push(`(
        ama.runtime_key = 'system'
        OR EXISTS (
          SELECT 1 FROM ai_provider_credentials apc
          WHERE apc.id = ama.credential_id
            AND (apc.scope_kind = 'SYSTEM' OR apc.scope_id = $${params.length})
        )
      )`);
    }
    const result = await this.db.query<ModelRow>(
      `
      SELECT am.*
      FROM ai_models am
      JOIN ai_model_availability ama ON ama.model_id = am.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY am.provider_id, am.model_id
      `,
      params,
    );
    return result.rows.map((row) => this.rowToEntry(row));
  }

  async listRoutingCandidates(query: RoutingCandidateQuery): Promise<RoutingModelCandidate[]> {
    const params: unknown[] = [];
    const clauses = ["ama.status = 'AVAILABLE'"];
    const capabilities = [...new Set(query.capabilities)];
    const lifecycleStages = query.lifecycleStages ?? ["VALIDATED", "ACTIVE"];

    params.push(lifecycleStages);
    clauses.push(`am.lifecycle_stage = ANY($${params.length}::text[])`);

    if (query.providerId) {
      params.push(query.providerId);
      clauses.push(`am.provider_id = $${params.length}`);
    }
    if (query.credentialId) {
      params.push(query.credentialId);
      clauses.push(`ama.credential_id = $${params.length}`);
      params.push(`credential:${query.credentialId}`);
      clauses.push(`ama.runtime_key = $${params.length}`);
    }
    if (query.scopeId) {
      params.push(query.scopeId);
      clauses.push(`(
        ama.runtime_key = 'system'
        OR (
          apc.id IS NOT NULL
          AND (apc.scope_kind = 'SYSTEM' OR apc.scope_id = $${params.length})
        )
      )`);
    }

    let validationJoin = "";
    let validationHaving = "";
    if (capabilities.length > 0) {
      params.push(capabilities);
      const capabilityParam = params.length;
      validationJoin = `
        JOIN ai_model_capability_validations acv
          ON acv.model_id = am.id
         AND acv.runtime_key = ama.runtime_key
         AND acv.status = 'VALIDATED'
         AND acv.capability = ANY($${capabilityParam}::text[])
      `;
      params.push(capabilities.length);
      validationHaving = `HAVING COUNT(DISTINCT acv.capability) = $${params.length}`;
    } else {
      validationJoin = `
        LEFT JOIN ai_model_capability_validations acv
          ON acv.model_id = am.id
         AND acv.runtime_key = ama.runtime_key
         AND acv.status = 'VALIDATED'
      `;
    }

    const result = await this.db.query<
      ModelRow & {
        model_uuid: string;
        runtime_key: string;
        credential_id: string | null;
        availability_status: string;
        availability_health: unknown;
        provider_status: string;
        provider_health: unknown;
        credential_status: string | null;
        credential_scope_kind: string | null;
        credential_scope_id: string | null;
        validation_quality: string | number | null;
        validation_latency_ms: string | number | null;
        validations: unknown;
      }
    >(
      `
      SELECT
        am.*,
        am.id AS model_uuid,
        ama.runtime_key,
        ama.credential_id,
        ama.status AS availability_status,
        ama.health AS availability_health,
        ap.status AS provider_status,
        ap.health AS provider_health,
        apc.status AS credential_status,
        apc.scope_kind AS credential_scope_kind,
        apc.scope_id AS credential_scope_id,
        AVG(acv.quality) AS validation_quality,
        AVG(acv.latency_ms) AS validation_latency_ms,
        COALESCE(
          jsonb_agg(
            DISTINCT jsonb_build_object(
              'capability', acv.capability,
              'quality', acv.quality,
              'latencyMs', acv.latency_ms,
              'checkedAt', acv.checked_at
            )
          ) FILTER (WHERE acv.capability IS NOT NULL),
          '[]'::jsonb
        ) AS validations
      FROM ai_models am
      JOIN ai_model_availability ama ON ama.model_id = am.id
      JOIN ai_providers ap ON ap.id = am.provider_id
      LEFT JOIN ai_provider_credentials apc ON apc.id = ama.credential_id
      ${validationJoin}
      WHERE ${clauses.join(" AND ")}
      GROUP BY am.id, ama.id, ap.id, apc.id
      ${validationHaving}
      ORDER BY am.provider_id, am.model_id, ama.runtime_key
      `,
      params,
    );

    return result.rows.map((row) => ({
      ...this.rowToEntry(row),
      modelUuid: row.model_uuid,
      runtimeKey: row.runtime_key,
      credentialId: row.credential_id,
      availabilityStatus: row.availability_status,
      availabilityHealth: row.availability_health,
      providerStatus: row.provider_status,
      providerHealth: row.provider_health,
      credentialStatus: row.credential_status,
      credentialScopeKind: row.credential_scope_kind,
      credentialScopeId: row.credential_scope_id,
      validations: parseRoutingValidations(row.validations),
      validationQuality: numberOrNull(row.validation_quality),
      validationLatencyMs: numberOrNull(row.validation_latency_ms),
    }));
  }

  async get(providerId: string, modelId: string): Promise<ModelRegistryEntry | undefined> {
    const result = await this.db.query<ModelRow>(
      "SELECT * FROM ai_models WHERE provider_id = $1 AND model_id = $2",
      [providerId, modelId],
    );
    const row = result.rows[0];
    return row ? this.rowToEntry(row) : undefined;
  }

  async list(options?: { lifecycleStage?: ModelLifecycleStage; providerId?: string }): Promise<ModelRegistryEntry[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (options?.providerId) {
      params.push(options.providerId);
      clauses.push(`provider_id = $${params.length}`);
    }
    if (options?.lifecycleStage) {
      params.push(options.lifecycleStage);
      clauses.push(`lifecycle_stage = $${params.length}`);
    }
    const result = await this.db.query<ModelRow>(
      `SELECT * FROM ai_models ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY provider_id, model_id`,
      params,
    );
    return result.rows.map((row) => this.rowToEntry(row));
  }

  async promote(providerId: string, modelId: string): Promise<void> {
    await this.setLifecycle(providerId, modelId, "ACTIVE");
  }

  async deprecate(providerId: string, modelId: string): Promise<void> {
    await this.setLifecycle(providerId, modelId, "DEPRECATED");
  }

  async quarantine(providerId: string, modelId: string): Promise<void> {
    await this.setLifecycle(providerId, modelId, "QUARANTINED");
  }

  private async loadProviders(providerId: string | undefined, limit: number): Promise<ProviderRow[]> {
    if (providerId) {
      return (
        await this.db.query<ProviderRow>(
          "SELECT * FROM ai_providers WHERE id = $1 AND enabled = true",
          [providerId],
        )
      ).rows;
    }
    return (
      await this.db.query<ProviderRow>(
        "SELECT * FROM ai_providers WHERE enabled = true ORDER BY slug LIMIT $1",
        [limit],
      )
    ).rows;
  }

  private async loadCredentials(providerId: string): Promise<CredentialRow[]> {
    return (
      await this.db.query<CredentialRow>(
        `
        SELECT id, provider_id, scope_kind, scope_id, label, credentials_encrypted
        FROM ai_provider_credentials
        WHERE provider_id = $1
        ORDER BY scope_kind, label, id
        `,
        [providerId],
      )
    ).rows;
  }

  private async loadCredential(credentialId: string, providerId: string): Promise<CredentialRow> {
    const result = await this.db.query<CredentialRow>(
      `
      SELECT id, provider_id, scope_kind, scope_id, label, credentials_encrypted
      FROM ai_provider_credentials
      WHERE id = $1 AND provider_id = $2
      `,
      [credentialId, providerId],
    );
    const credential = result.rows[0];
    if (!credential) throw new Error("AI provider credential is unavailable for this provider");
    return credential;
  }

  private resolveRuntime(provider: ProviderRow, credential?: CredentialRow): RuntimeContext {
    const allowPrivateNetwork = configBoolean(provider.config, "allowPrivateNetwork");
    const baseUrl = validateProviderBaseUrl(provider.base_url, {
      allowPrivateNetwork,
    });
    let apiKey: string | undefined;
    if (credential) {
      apiKey = decryptSecret(
        credential.credentials_encrypted,
        undefined,
        aiProviderCredentialAssociatedData({
          credentialId: credential.id,
          providerId: credential.provider_id,
          scopeKind: credential.scope_kind,
          scopeId: credential.scope_id,
        }),
      );
    } else if (provider.api_key_encrypted) {
      apiKey = decryptSecret(provider.api_key_encrypted);
    }
    return {
      provider,
      ...(credential ? { credential } : {}),
      runtimeKey: runtimeKey(credential),
      ...(apiKey ? { apiKey } : {}),
      baseUrl,
      allowPrivateNetwork,
    };
  }

  private async refreshRuntime(
    ctx: RuntimeContext,
    options: { maxModelsPerProvider: number; maxProbeModels: number; probeTimeoutMs: number },
  ): Promise<RuntimeRefreshResult> {
    const adapter = this.adapters.get(ctx.provider.protocol);
    if (!adapter) {
      const failure: DiscoveryFailure = {
        ok: false,
        health: "CONFIGURATION_MISSING",
        retryable: false,
        safeError: { code: "ADAPTER_UNCONFIGURED", message: "Provider protocol adapter is not configured" },
      };
      await this.recordDiscoveryFailure(ctx, failure);
      return this.runtimeResult(ctx, failure, 0, 0);
    }

    await this.db.query(
      "UPDATE ai_providers SET last_discovery_attempt_at = now(), updated_at = now() WHERE id = $1",
      [ctx.provider.id],
    );
    const discovery = await adapter.discover({
      providerId: ctx.provider.id,
      slug: ctx.provider.slug,
      name: ctx.provider.name,
      protocol: ctx.provider.protocol,
      baseUrl: ctx.baseUrl,
      credential: {
        ...(ctx.credential ? { credentialId: ctx.credential.id } : {}),
        ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
      },
      timeoutMs: getEnv().AI_MODEL_DISCOVERY_SWEEP_TIMEOUT_MS,
      allowPrivateNetwork: ctx.allowPrivateNetwork,
      ...(ctx.dnsLookup ? { dnsLookup: ctx.dnsLookup } : {}),
    });
    if (!discovery.ok) {
      await this.recordDiscoveryFailure(ctx, discovery);
      return this.runtimeResult(ctx, discovery, 0, 0);
    }

    const persisted = await this.persistDiscovery(ctx, discovery.models.slice(0, options.maxModelsPerProvider));
    const provider = this.createProbeProvider(ctx);
    const probeCandidates = persisted
      .filter((candidate) => candidate.probeCapabilities.length > 0 && candidate.needsProbe)
      .slice(0, options.maxProbeModels);
    let probedModels = 0;
    for (const candidate of probeCandidates) {
      const results = await this.prober.probe(
        provider,
        candidate.providerModelId,
        candidate.probeCapabilities,
        { timeoutMs: options.probeTimeoutMs },
      );
      await this.persistProbeResults(ctx, candidate.modelUuid, results);
      probedModels += 1;
    }

    await this.recordDiscoverySuccess(ctx);
    return this.runtimeResult(ctx, discovery, persisted.length, probedModels);
  }

  private runtimeResult(
    ctx: RuntimeContext,
    discovery: DiscoveryResult,
    persistedModels: number,
    probedModels: number,
  ): RuntimeRefreshResult {
    return {
      providerId: ctx.provider.id,
      ...(ctx.credential ? { credentialId: ctx.credential.id } : {}),
      runtimeKey: ctx.runtimeKey,
      discovery,
      persistedModels,
      probedModels,
    };
  }

  private async recordDiscoveryFailure(ctx: RuntimeContext, failure: DiscoveryFailure): Promise<void> {
    if (ctx.credential) {
      await this.db.query(
        `
        UPDATE ai_provider_credentials
        SET status = $2, health = $3::jsonb, updated_at = now()
        WHERE id = $1
        `,
        [
          ctx.credential.id,
          failure.health,
          JSON.stringify({ status: failure.health, checkedAt: new Date().toISOString() }),
        ],
      );
      await this.recomputeProviderHealth(ctx.provider.id, failure.safeError);
      return;
    }
    await this.db.query(
      `
      UPDATE ai_providers
      SET status = $2,
          health = $3::jsonb,
          last_discovery_error = $4::jsonb,
          updated_at = now()
      WHERE id = $1
      `,
      [
        ctx.provider.id,
        failure.health,
        JSON.stringify({ status: failure.health, checkedAt: new Date().toISOString() }),
        JSON.stringify(failure.safeError),
      ],
    );
  }

  private async recordDiscoverySuccess(ctx: RuntimeContext): Promise<void> {
    if (ctx.credential) {
      await this.db.query(
        `
        UPDATE ai_provider_credentials
        SET status = 'HEALTHY',
            health = $2::jsonb,
            last_validated_at = now(),
            last_used_at = now(),
            updated_at = now()
        WHERE id = $1
        `,
        [ctx.credential.id, JSON.stringify({ status: "HEALTHY", checkedAt: new Date().toISOString() })],
      );
      await this.recomputeProviderHealth(ctx.provider.id);
      return;
    }
    await this.db.query(
      `
      UPDATE ai_providers
      SET status = 'HEALTHY',
          health = $2::jsonb,
          last_successful_discovery_at = now(),
          last_discovery_error = NULL,
          updated_at = now()
      WHERE id = $1
      `,
      [ctx.provider.id, JSON.stringify({ status: "HEALTHY", checkedAt: new Date().toISOString() })],
    );
  }

  private async persistDiscovery(
    ctx: RuntimeContext,
    models: DiscoveredModel[],
  ): Promise<Array<{ modelUuid: string; providerModelId: string; probeCapabilities: AiCapability[]; needsProbe: boolean }>> {
    const client = await this.transactionClient();
    await client.query("BEGIN");
    try {
      const persisted: Array<{ modelUuid: string; providerModelId: string; probeCapabilities: AiCapability[]; needsProbe: boolean }> = [];
      for (const model of models) {
        const existing = await client.query<Pick<ModelRow, "id" | "version" | "fingerprint" | "lifecycle_stage">>(
          "SELECT id, version, fingerprint, lifecycle_stage FROM ai_models WHERE provider_id = $1 AND model_id = $2",
          [ctx.provider.id, model.providerModelId],
        );
        const prior = existing.rows[0];
        const materialChange = Boolean(
          prior &&
            ((model.version !== undefined && model.version !== prior.version) ||
              (model.fingerprint !== undefined && model.fingerprint !== prior.fingerprint)),
        );
        const lifecycleStage: ModelLifecycleStage = prior
          ? materialChange
            ? "PROBING"
            : prior.lifecycle_stage
          : "DISCOVERED";
        const capabilities = providerCapabilities(model);
        const probeCapabilities = this.planProbeCapabilities(ctx, model);
        const upsert = await client.query<{ id: string }>(
          `
          INSERT INTO ai_models (
            provider_id, model_id, display_name, version, fingerprint, lifecycle_stage,
            capabilities, capability_evidence, context_limit, output_limit, provider_metadata,
            health, first_seen_at, last_seen_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb, now(), now(), now())
          ON CONFLICT (provider_id, model_id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            version = EXCLUDED.version,
            fingerprint = EXCLUDED.fingerprint,
            lifecycle_stage = EXCLUDED.lifecycle_stage,
            capabilities = EXCLUDED.capabilities,
            capability_evidence = EXCLUDED.capability_evidence,
            context_limit = EXCLUDED.context_limit,
            output_limit = EXCLUDED.output_limit,
            provider_metadata = EXCLUDED.provider_metadata,
            health = EXCLUDED.health,
            last_seen_at = now(),
            updated_at = now()
          RETURNING id
          `,
          [
            ctx.provider.id,
            model.providerModelId,
            model.displayName ?? model.providerModelId,
            model.version ?? null,
            model.fingerprint ?? null,
            lifecycleStage,
            JSON.stringify(capabilities),
            JSON.stringify({ advertised: capabilities }),
            model.contextLimit ?? null,
            model.outputLimit ?? null,
            JSON.stringify(model.providerMetadata),
            JSON.stringify({ healthy: true, lastChecked: new Date().toISOString() }),
          ],
        );
        const modelUuid = upsert.rows[0]?.id;
        if (!modelUuid) throw new Error("AI model upsert failed");
        if (materialChange) {
          await client.query("DELETE FROM ai_model_capability_validations WHERE model_id = $1", [modelUuid]);
        }
        await client.query(
          `
          INSERT INTO ai_model_availability (
            provider_id, model_id, credential_id, runtime_key, status,
            capability_evidence, health, last_seen_at, last_checked_at, metadata, updated_at
          )
          VALUES ($1, $2, $3, $4, 'AVAILABLE', $5::jsonb, $6::jsonb, now(), now(), $7::jsonb, now())
          ON CONFLICT (model_id, runtime_key) DO UPDATE SET
            status = 'AVAILABLE',
            capability_evidence = EXCLUDED.capability_evidence,
            health = EXCLUDED.health,
            last_seen_at = now(),
            last_checked_at = now(),
            metadata = EXCLUDED.metadata,
            updated_at = now()
          `,
          [
            ctx.provider.id,
            modelUuid,
            ctx.credential?.id ?? null,
            ctx.runtimeKey,
            JSON.stringify({ advertised: capabilities }),
            JSON.stringify({ healthy: true, lastChecked: new Date().toISOString() }),
            JSON.stringify({ discovery: { source: ctx.provider.protocol, missedCount: 0 } }),
          ],
        );
        persisted.push({
          modelUuid,
          providerModelId: model.providerModelId,
          probeCapabilities,
          needsProbe:
            !prior ||
            materialChange ||
            prior.lifecycle_stage === "DISCOVERED" ||
            prior.lifecycle_stage === "PROBING" ||
            prior.lifecycle_stage === "QUARANTINED",
        });
      }
      await this.markMissingModelsTx(client, ctx, persisted.map((item) => item.modelUuid));
      await client.query("COMMIT");
      return persisted;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async persistProbeResults(
    ctx: RuntimeContext,
    modelUuid: string,
    results: ModelProbeResult[],
  ): Promise<void> {
    const client = await this.transactionClient();
    await client.query("BEGIN");
    try {
      for (const result of results) {
        await client.query(
          `
          INSERT INTO ai_model_capability_validations (
            model_id, credential_id, runtime_key, capability, status, quality, latency_ms, safe_error, checked_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), now())
          ON CONFLICT (model_id, runtime_key, capability) DO UPDATE SET
            status = EXCLUDED.status,
            quality = EXCLUDED.quality,
            latency_ms = EXCLUDED.latency_ms,
            safe_error = EXCLUDED.safe_error,
            checked_at = now(),
            updated_at = now()
          `,
          [
            modelUuid,
            ctx.credential?.id ?? null,
            ctx.runtimeKey,
            result.capability,
            result.success ? "VALIDATED" : "FAILED",
            result.quality,
            result.latencyMs,
            result.error ? JSON.stringify({ message: result.error.slice(0, 160) }) : null,
          ],
        );
      }
      const anySucceeded = results.some((result) => result.success);
      await client.query(
        `
        UPDATE ai_model_availability
        SET health = $3::jsonb,
            last_probed_at = now(),
            updated_at = now()
        WHERE model_id = $1 AND runtime_key = $2
        `,
        [
          modelUuid,
          ctx.runtimeKey,
          JSON.stringify({ healthy: anySucceeded, lastChecked: new Date().toISOString() }),
        ],
      );
      await this.recomputeModelLifecycleTx(client, modelUuid);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private createProbeProvider(ctx: RuntimeContext): BaseAiProvider {
    const manifestCapabilities: AiCapability[] = [
      "text_generation",
      "structured_output",
      "tool_calling",
      "vision",
      "embeddings",
      "streaming",
      "reasoning",
    ];
    const provider =
      ctx.provider.protocol === "anthropic"
        ? new AnthropicProvider()
        : new OpenAICompatibleProvider(ctx.provider.slug, ctx.provider.name, manifestCapabilities);
    provider.configure({
      baseUrl: ctx.baseUrl,
      ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
      timeout: getEnv().AI_MODEL_PROBE_TIMEOUT_MS,
      metadata: {
        allowPrivateNetwork: ctx.allowPrivateNetwork,
        ...(ctx.dnsLookup ? { dnsLookup: ctx.dnsLookup } : {}),
      },
    });
    return provider;
  }

  private planProbeCapabilities(ctx: RuntimeContext, model: DiscoveredModel): AiCapability[] {
    const advertised = providerCapabilities(model);
    if (advertised.length > 0) return advertised;
    const configured = configCapabilities(ctx.provider.config);
    return configured.length > 0 ? configured : defaultProbeCapabilities(ctx.provider.protocol);
  }

  private async markMissingModelsTx(
    client: DbExecutor,
    ctx: RuntimeContext,
    seenModelUuids: string[],
  ): Promise<void> {
    const threshold = getEnv().AI_MODEL_DISCOVERY_MISSED_THRESHOLD;
    const params: unknown[] = [ctx.provider.id, ctx.runtimeKey];
    const seenClause =
      seenModelUuids.length > 0
        ? `AND ama.model_id <> ALL($3::uuid[])`
        : "";
    if (seenModelUuids.length > 0) params.push(seenModelUuids);
    const missing = await client.query<{ model_id: string; metadata: unknown }>(
      `
      SELECT ama.model_id, ama.metadata
      FROM ai_model_availability ama
      WHERE ama.provider_id = $1
        AND ama.runtime_key = $2
        AND ama.status = 'AVAILABLE'
        ${seenClause}
      `,
      params,
    );
    for (const row of missing.rows) {
      const metadata = row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
      const discovery = metadata.discovery && typeof metadata.discovery === "object"
        ? (metadata.discovery as Record<string, unknown>)
        : {};
      const missedCount =
        typeof discovery.missedCount === "number" ? discovery.missedCount + 1 : 1;
      const updatedMetadata = {
        ...metadata,
        discovery: {
          ...discovery,
          missedCount,
          lastMissedAt: new Date().toISOString(),
        },
      };
      await client.query(
        `
        UPDATE ai_model_availability
        SET status = $3,
            metadata = $4::jsonb,
            last_checked_at = now(),
            updated_at = now()
        WHERE model_id = $1 AND runtime_key = $2
        `,
        [
          row.model_id,
          ctx.runtimeKey,
          missedCount >= threshold ? "UNAVAILABLE" : "AVAILABLE",
          JSON.stringify(updatedMetadata),
        ],
      );
    }
  }

  private async recomputeModelLifecycleTx(client: DbExecutor, modelUuid: string): Promise<void> {
    const current = await client.query<{ lifecycle_stage: ModelLifecycleStage }>(
      "SELECT lifecycle_stage FROM ai_models WHERE id = $1",
      [modelUuid],
    );
    const currentStage = current.rows[0]?.lifecycle_stage ?? "DISCOVERED";
    const aggregate = await client.query<{ validated_count: number; validation_count: number }>(
      `
      SELECT
        count(*) FILTER (WHERE status = 'VALIDATED')::int AS validated_count,
        count(*)::int AS validation_count
      FROM ai_model_capability_validations
      WHERE model_id = $1
      `,
      [modelUuid],
    );
    const validatedCount = aggregate.rows[0]?.validated_count ?? 0;
    const validationCount = aggregate.rows[0]?.validation_count ?? 0;
    const nextStage: ModelLifecycleStage =
      validatedCount > 0
        ? currentStage === "ACTIVE"
          ? "ACTIVE"
          : "VALIDATED"
        : validationCount > 0
          ? "QUARANTINED"
          : currentStage;
    await client.query(
      `
      UPDATE ai_models
      SET lifecycle_stage = $2,
          health = $3::jsonb,
          last_probed_at = now(),
          updated_at = now()
      WHERE id = $1
      `,
      [
        modelUuid,
        nextStage,
        JSON.stringify({
          healthy: validatedCount > 0,
          validatedRuntimeCapabilities: validatedCount,
          validationCount,
          lastChecked: new Date().toISOString(),
        }),
      ],
    );
  }

  private async recomputeProviderHealth(
    providerId: string,
    latestError?: DiscoveryFailure["safeError"],
  ): Promise<void> {
    const aggregate = await this.db.query<{ total: number; healthy: number; unhealthy: number }>(
      `
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'HEALTHY')::int AS healthy,
        count(*) FILTER (WHERE status <> 'HEALTHY')::int AS unhealthy
      FROM ai_provider_credentials
      WHERE provider_id = $1
      `,
      [providerId],
    );
    const total = aggregate.rows[0]?.total ?? 0;
    if (total === 0) return;
    const healthy = aggregate.rows[0]?.healthy ?? 0;
    const unhealthy = aggregate.rows[0]?.unhealthy ?? 0;
    const status = healthy > 0 && unhealthy > 0 ? "DEGRADED" : healthy > 0 ? "HEALTHY" : "TEMPORARILY_UNAVAILABLE";
    await this.db.query(
      `
      UPDATE ai_providers
      SET status = $2,
          health = $3::jsonb,
          last_successful_discovery_at = CASE WHEN $2 IN ('HEALTHY', 'DEGRADED') THEN now() ELSE last_successful_discovery_at END,
          last_discovery_error = CASE WHEN $4::jsonb IS NULL OR $2 = 'HEALTHY' THEN NULL ELSE $4::jsonb END,
          updated_at = now()
      WHERE id = $1
      `,
      [
        providerId,
        status,
        JSON.stringify({
          status,
          runtimes: { total, healthy, unhealthy },
          checkedAt: new Date().toISOString(),
        }),
        latestError ? JSON.stringify(latestError) : null,
      ],
    );
  }

  private async transactionClient(): Promise<TransactionClient> {
    if (!this.db.connect) {
      throw new Error("Model registry persistence requires a transaction-capable database client");
    }
    return this.db.connect();
  }

  private async setLifecycle(providerId: string, modelId: string, stage: ModelLifecycleStage): Promise<void> {
    await this.db.query(
      "UPDATE ai_models SET lifecycle_stage = $3, updated_at = now() WHERE provider_id = $1 AND model_id = $2",
      [providerId, modelId, stage],
    );
  }

  private rowToEntry(row: ModelRow): ModelRegistryEntry {
    return {
      providerId: row.provider_id,
      modelId: row.model_id,
      ...(row.display_name ? { displayName: row.display_name } : {}),
      ...(row.version ? { version: row.version } : {}),
      ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
      lifecycleStage: row.lifecycle_stage,
      capabilities: Array.isArray(row.capabilities)
        ? row.capabilities.filter((item): item is string => typeof item === "string")
        : [],
      ...(row.context_limit !== null ? { contextLimit: row.context_limit } : {}),
      health:
        row.health && typeof row.health === "object" && "healthy" in row.health
          ? (row.health as { healthy: boolean; lastChecked: string })
          : { healthy: false, lastChecked: new Date().toISOString() },
      lastSeenAt: dateIso(row.last_seen_at),
      ...(row.last_probed_at ? { lastProbedAt: dateIso(row.last_probed_at) } : {}),
      createdAt: dateIso(row.created_at),
    };
  }
}

export const modelRegistry = new ModelRegistryService();
