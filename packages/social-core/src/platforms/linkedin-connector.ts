import type { ConnectorManifest } from "@xlrrank/shared";
import { BaseSocialConnector } from "../connectors/base.js";

export class LinkedInConnector extends BaseSocialConnector {
  protected manifest: ConnectorManifest = {
    id: "linkedin",
    platformId: "linkedin",
    name: "LinkedIn",
    version: "0.1.0",
    capabilities: {
      profiles: "CONFIGURATION_REQUIRED",
      content: "CONFIGURATION_REQUIRED",
      metrics: "CONFIGURATION_REQUIRED",
      followers: "CONFIGURATION_REQUIRED",
      following: "CONFIGURATION_REQUIRED",
      comments: "APP_REVIEW_REQUIRED",
      search: "APP_REVIEW_REQUIRED",
    },
  };
}
