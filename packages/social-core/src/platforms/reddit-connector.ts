import type { ConnectorManifest } from "@xlrrank/shared";
import { BaseSocialConnector } from "../connectors/base.js";

export class RedditConnector extends BaseSocialConnector {
  protected manifest: ConnectorManifest = {
    id: "reddit",
    platformId: "reddit",
    name: "Reddit",
    version: "0.1.0",
    capabilities: {
      profiles: "CONFIGURATION_REQUIRED",
      content: "CONFIGURATION_REQUIRED",
      comments: "CONFIGURATION_REQUIRED",
      search: "CONFIGURATION_REQUIRED",
      metrics: "CONFIGURATION_REQUIRED",
    },
  };
}
