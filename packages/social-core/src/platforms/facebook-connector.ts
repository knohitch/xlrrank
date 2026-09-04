import type { ConnectorManifest } from "@xlrrank/shared";
import { BaseSocialConnector } from "../connectors/base.js";

export class FacebookConnector extends BaseSocialConnector {
  protected manifest: ConnectorManifest = {
    id: "facebook",
    platformId: "facebook",
    name: "Facebook",
    version: "0.1.0",
    capabilities: {
      profiles: "CONFIGURATION_REQUIRED",
      content: "CONFIGURATION_REQUIRED",
      comments: "CONFIGURATION_REQUIRED",
      metrics: "CONFIGURATION_REQUIRED",
    },
  };
}
