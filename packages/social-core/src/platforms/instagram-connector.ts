import type { ConnectorManifest } from "@xlrrank/shared";
import { BaseSocialConnector } from "../connectors/base.js";

export class InstagramConnector extends BaseSocialConnector {
  protected manifest: ConnectorManifest = {
    id: "instagram",
    platformId: "instagram",
    name: "Instagram",
    version: "0.1.0",
    capabilities: {
      profiles: "CONFIGURATION_REQUIRED",
      content: "CONFIGURATION_REQUIRED",
      comments: "CONFIGURATION_REQUIRED",
      metrics: "CONFIGURATION_REQUIRED",
      followers: "CONFIGURATION_REQUIRED",
      following: "CONFIGURATION_REQUIRED",
      search: "UNAVAILABLE",
    },
  };
}
