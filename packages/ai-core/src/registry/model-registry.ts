import type { AiModelDescriptor } from "../manifest.js";
import type { BaseAiProvider } from "../providers/base.js";
import type { ModelRegistryEntry, ModelLifecycleStage, DiscoveryConfig } from "./types.js";
import { ModelProber } from "./model-probe.js";

export class ModelRegistryService {
  private models = new Map<string, ModelRegistryEntry>();
  private prober = new ModelProber();
  private discoveryConfig: DiscoveryConfig = {
    intervalMs: 60 * 60 * 1000,
    autoProbe: true,
    autoPromote: false,
  };

  configure(config: Partial<DiscoveryConfig>): void {
    this.discoveryConfig = { ...this.discoveryConfig, ...config };
  }

  async discoverFromProvider(provider: BaseAiProvider): Promise<ModelRegistryEntry[]> {
    const manifest = provider.getManifest();
    let models: AiModelDescriptor[];
    try {
      models = await provider.listModels();
    } catch {
      return [];
    }

    const discovered: ModelRegistryEntry[] = [];
    for (const model of models) {
      const k = this.key(manifest.id, model.modelId);
      const existing = this.models.get(k);
      if (existing) {
        existing.lastSeenAt = new Date().toISOString();
        if (model.version && model.version !== existing.version) {
          existing.lifecycleStage = "PROBING";
          existing.version = model.version;
        }
        continue;
      }

      const caps = model.capabilities ? [...model.capabilities] : [...manifest.capabilities];
      const entry: ModelRegistryEntry = {
        providerId: manifest.id,
        modelId: model.modelId,
        lifecycleStage: "DISCOVERED",
        capabilities: caps,
        health: { healthy: true, lastChecked: new Date().toISOString() },
        lastSeenAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      if (model.displayName !== undefined) entry.displayName = model.displayName;
      if (model.version !== undefined) entry.version = model.version;
      if (model.contextLimit !== undefined) entry.contextLimit = model.contextLimit;

      this.models.set(k, entry);
      discovered.push(entry);

      if (this.discoveryConfig.autoProbe) {
        this.probeAndUpdate(provider, entry).catch(() => {});
      }
    }
    return discovered;
  }

  private async probeAndUpdate(
    provider: BaseAiProvider,
    entry: ModelRegistryEntry,
  ): Promise<void> {
    entry.lifecycleStage = "PROBING";
    try {
      const results = await this.prober.probe(provider, entry.modelId);
      entry.lastProbedAt = new Date().toISOString();
      const allSuccess = results.every((r) => r.success);
      entry.lifecycleStage = allSuccess ? "VALIDATED" : "QUARANTINED";
      entry.health = {
        healthy: allSuccess,
        lastChecked: new Date().toISOString(),
      };
      if (allSuccess && this.discoveryConfig.autoPromote) {
        entry.lifecycleStage = "ACTIVE";
      }
    } catch {
      entry.lifecycleStage = "QUARANTINED";
      entry.health = { healthy: false, lastChecked: new Date().toISOString() };
    }
  }

  get(providerId: string, modelId: string): ModelRegistryEntry | undefined {
    return this.models.get(this.key(providerId, modelId));
  }

  list(options?: { lifecycleStage?: ModelLifecycleStage; providerId?: string }): ModelRegistryEntry[] {
    let entries = [...this.models.values()];
    if (options?.lifecycleStage) {
      entries = entries.filter((e) => e.lifecycleStage === options.lifecycleStage);
    }
    if (options?.providerId) {
      entries = entries.filter((e) => e.providerId === options.providerId);
    }
    return entries;
  }

  promote(providerId: string, modelId: string): void {
    const entry = this.models.get(this.key(providerId, modelId));
    if (entry) entry.lifecycleStage = "ACTIVE";
  }

  deprecate(providerId: string, modelId: string): void {
    const entry = this.models.get(this.key(providerId, modelId));
    if (entry) entry.lifecycleStage = "DEPRECATED";
  }

  quarantine(providerId: string, modelId: string): void {
    const entry = this.models.get(this.key(providerId, modelId));
    if (entry) entry.lifecycleStage = "QUARANTINED";
  }

  private key(providerId: string, modelId: string): string {
    return `${providerId}:${modelId}`;
  }
}

export const modelRegistry = new ModelRegistryService();
