import type { AiCapability } from "./capabilities.js";

export interface AiProviderManifest {
  id: string;
  name: string;
  protocol: string;
  capabilities: AiCapability[];
}

export interface AiModelDescriptor {
  providerId: string;
  modelId: string;
  displayName?: string;
  version?: string;
  capabilities?: AiCapability[];
  contextLimit?: number;
}
