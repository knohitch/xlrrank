export type ModelLifecycleStage =
  | "DISCOVERED"
  | "PROBING"
  | "VALIDATED"
  | "ACTIVE"
  | "DEPRECATED"
  | "RETIRED"
  | "QUARANTINED";

export interface ModelRegistryEntry {
  providerId: string;
  modelId: string;
  displayName?: string;
  version?: string;
  fingerprint?: string;
  lifecycleStage: ModelLifecycleStage;
  capabilities: string[];
  contextLimit?: number;
  pricing?: { inputPer1k?: number; outputPer1k?: number };
  health: { healthy: boolean; lastChecked: string };
  lastSeenAt: string;
  lastProbedAt?: string;
  createdAt: string;
}

export interface ModelProbeResult {
  capability: string;
  quality: number;
  latencyMs: number;
  success: boolean;
  error?: string;
}

export interface DiscoveryConfig {
  intervalMs: number;
  autoProbe: boolean;
  autoPromote: boolean;
}
