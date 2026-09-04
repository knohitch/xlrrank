import type { ConnectorManifest } from "@xlrrank/shared";
import { BaseSocialConnector } from "../connectors/base.js";

export class XConnector extends BaseSocialConnector {
  protected manifest: ConnectorManifest = {
    id: "x",
    platformId: "x",
    name: "X (Twitter)",
    version: "0.1.0",
    apiVersion: "2",
    capabilities: {
      profiles: "CONFIGURATION_REQUIRED",
      content: "CONFIGURATION_REQUIRED",
      comments: "CONFIGURATION_REQUIRED",
      search: "CONFIGURATION_REQUIRED",
      metrics: "CONFIGURATION_REQUIRED",
      followers: "CONFIGURATION_REQUIRED",
      following: "CONFIGURATION_REQUIRED",
    },
  };
}
