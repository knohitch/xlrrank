import type { ConnectorManifest } from "@xlrrank/shared";
import type { SocialConnector } from "./types.js";

export interface ConnectorDefinition {
  manifest: ConnectorManifest;
  create: () => SocialConnector;
  testOnly?: boolean;
}

export class ConnectorRegistry {
  private definitions = new Map<string, ConnectorDefinition>();

  registerFactory(create: () => SocialConnector, options: { testOnly?: boolean } = {}): void {
    const connector = create();
    const manifest = connector.getManifest();
    if (options.testOnly && process.env.NODE_ENV === "production") {
      throw new Error(`Refusing to register test-only connector '${manifest.id}' in production`);
    }
    this.definitions.set(manifest.platformId, {
      manifest,
      create,
      testOnly: options.testOnly ?? false,
    });
  }

  getDefinition(platformId: string): ConnectorDefinition | undefined {
    return this.definitions.get(platformId);
  }

  create(platformId: string): SocialConnector | undefined {
    return this.definitions.get(platformId)?.create();
  }

  getBySlug(slug: string): ConnectorDefinition | undefined {
    for (const definition of this.definitions.values()) {
      if (definition.manifest.id === slug) return definition;
    }
    return undefined;
  }

  list(): Array<{ manifest: ConnectorManifest; status: string }> {
    return [...this.definitions.values()].map((definition) => ({
      manifest: definition.manifest,
      status: "DISCONNECTED",
    }));
  }

  listRegistered(): ConnectorDefinition[] {
    return [...this.definitions.values()];
  }

  has(platformId: string): boolean {
    return this.definitions.has(platformId);
  }

  unregister(platformId: string): boolean {
    return this.definitions.delete(platformId);
  }

  clear(): void {
    this.definitions.clear();
  }
}

export const connectorRegistry = new ConnectorRegistry();
