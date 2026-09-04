import type { ConnectorManifest } from "@xlrrank/shared";
import type { SocialConnector } from "./types.js";

export class ConnectorRegistry {
  private connectors = new Map<string, SocialConnector>();

  register(connector: SocialConnector): void {
    const manifest = connector.getManifest();
    this.connectors.set(manifest.platformId, connector);
  }

  get(platformId: string): SocialConnector | undefined {
    return this.connectors.get(platformId);
  }

  getBySlug(slug: string): SocialConnector | undefined {
    for (const connector of this.connectors.values()) {
      if (connector.getManifest().id === slug) return connector;
    }
    return undefined;
  }

  list(): Array<{ manifest: ConnectorManifest; status: string }> {
    return [...this.connectors.values()].map((c) => ({
      manifest: c.getManifest(),
      status: c.getStatus(),
    }));
  }

  listRegistered(): SocialConnector[] {
    return [...this.connectors.values()];
  }

  has(platformId: string): boolean {
    return this.connectors.has(platformId);
  }

  unregister(platformId: string): boolean {
    return this.connectors.delete(platformId);
  }
}

export const connectorRegistry = new ConnectorRegistry();
