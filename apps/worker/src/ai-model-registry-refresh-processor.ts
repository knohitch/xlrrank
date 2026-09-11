import type { Job } from "bullmq";
import { modelRegistry } from "@xlrrank/ai-core";
import type { AiModelRegistryRefreshPayload } from "@xlrrank/queue";

export async function processAiModelRegistryRefresh(
  job: Job<AiModelRegistryRefreshPayload>,
): Promise<{ refreshedRuntimes: number }> {
  const result = await modelRegistry.refresh({
    ...(job.data.providerId ? { providerId: job.data.providerId } : {}),
    ...(job.data.credentialId ? { credentialId: job.data.credentialId } : {}),
    reason: job.data.reason,
  });
  return { refreshedRuntimes: result.runtimes.length };
}

