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
import { validateProviderBaseUrl } from "./endpoint-policy.js";
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

interface RuntimeContext {
  provider: ProviderRow;
  credential?: CredentialRow;
  runtimeKey: string;
  apiKey?: string;
  baseUrl: string;
}

function configBoolean(config: Record<string, unknown> | null, key: string): boolean {
  return config?.[key] === true;
}

function providerCapabilities(model: DiscoveredModel): AiCapability[] {
  return [...new Set(model.advertisedCapabilities)];
}

function runtimeKey(credential?: CredentialRow): string {
  return credential ? `credential:${credential.id}` : "system";
}

function dateIso(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : value;
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
    const baseUrl = validateProviderBaseUrl(provider.base_url, {
      allowPrivateNetwork: configBoolean(provider.config, "allowPrivateNetwork"),
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
    });
    if (!discovery.ok) {
      await this.recordDiscoveryFailure(ctx, discovery);
      return this.runtimeResult(ctx, discovery, 0, 0);
    }

    const persisted = await this.persistDiscovery(ctx, discovery.models.slice(0, options.maxModelsPerProvider));
    const provider = this.createProbeProvider(ctx);
    const probeCandidates = persisted
      .filter((candidate) => candidate.capabilities.length > 0 && candidate.needsProbe)
      .slice(0, options.maxProbeModels);
    let probedModels = 0;
    for (const candidate of probeCandidates) {
      const results = await this.prober.probe(
        provider,
        candidate.providerModelId,
        candidate.capabilities,
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
    }
  }

  private async recordDiscoverySuccess(ctx: RuntimeContext): Promise<void> {
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
    }
  }

  private async persistDiscovery(
    ctx: RuntimeContext,
    models: DiscoveredModel[],
  ): Promise<Array<{ modelUuid: string; providerModelId: string; capabilities: AiCapability[]; needsProbe: boolean }>> {
    await this.db.query("BEGIN");
    try {
      const persisted: Array<{ modelUuid: string; providerModelId: string; capabilities: AiCapability[]; needsProbe: boolean }> = [];
      for (const model of models) {
        const existing = await this.db.query<Pick<ModelRow, "id" | "version" | "fingerprint" | "lifecycle_stage">>(
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
        const upsert = await this.db.query<{ id: string }>(
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
        await this.db.query(
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
            JSON.stringify({ discovery: { source: ctx.provider.protocol } }),
          ],
        );
        persisted.push({
          modelUuid,
          providerModelId: model.providerModelId,
          capabilities,
          needsProbe:
            !prior ||
            materialChange ||
            prior.lifecycle_stage === "DISCOVERED" ||
            prior.lifecycle_stage === "PROBING",
        });
      }
      await this.db.query("COMMIT");
      return persisted;
    } catch (err) {
      await this.db.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  private async persistProbeResults(
    ctx: RuntimeContext,
    modelUuid: string,
    results: ModelProbeResult[],
  ): Promise<void> {
    await this.db.query("BEGIN");
    try {
      for (const result of results) {
        await this.db.query(
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
      const allSucceeded = results.length > 0 && results.every((result) => result.success);
      await this.db.query(
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
          allSucceeded ? "VALIDATED" : "QUARANTINED",
          JSON.stringify({ healthy: allSucceeded, lastChecked: new Date().toISOString() }),
        ],
      );
      await this.db.query(
        "UPDATE ai_model_availability SET last_probed_at = now(), updated_at = now() WHERE model_id = $1 AND runtime_key = $2",
        [modelUuid, ctx.runtimeKey],
      );
      await this.db.query("COMMIT");
    } catch (err) {
      await this.db.query("ROLLBACK").catch(() => {});
      throw err;
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
    });
    return provider;
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
