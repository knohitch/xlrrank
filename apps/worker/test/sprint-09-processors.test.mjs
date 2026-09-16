import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.ENCRYPTION_MASTER_KEY ??= "master-test-key-32-bytes-minimum-required";

test("Worker: processProviderAuthorizationCleanup rejects wrong job name", async () => {
  const { processProviderAuthorizationCleanup } = await import("../dist/provider-authorization-cleanup-processor.js");
  await assert.rejects(
    () => processProviderAuthorizationCleanup({ name: "unsupported.job", data: {} }),
    /Unsupported provider authorization cleanup job type/,
  );
});

test("Worker: processProviderDataDeletion rejects wrong job name", async () => {
  const { processProviderDataDeletion } = await import("../dist/provider-data-deletion-processor.js");
  await assert.rejects(
    () => processProviderDataDeletion({ name: "unsupported.job", data: {} }),
    /Unsupported provider data deletion job type/,
  );
});

test("Worker: dispatchOutboxOnce supports providerAuthorizationCleanup and providerDataDeletion payload dispatching", async () => {
  const { JOB_TYPES, QUEUE_NAMES, parseProviderAuthorizationCleanupPayload, parseProviderDataDeletionPayload } =
    await import("@xlrrank/queue");

  const cleanupPayload = {
    version: 1,
    jobRequestId: "11111111-1111-4111-8111-111111111111",
    cleanupId: "22222222-2222-4222-8222-222222222222",
  };
  const parsedCleanup = parseProviderAuthorizationCleanupPayload(cleanupPayload);
  assert.equal(parsedCleanup.jobRequestId, cleanupPayload.jobRequestId);
  assert.equal(parsedCleanup.cleanupId, cleanupPayload.cleanupId);

  const deletionPayload = {
    version: 1,
    jobRequestId: "33333333-3333-4333-8333-333333333333",
    deletionRequestId: "44444444-4444-4444-8444-444444444444",
  };
  const parsedDeletion = parseProviderDataDeletionPayload(deletionPayload);
  assert.equal(parsedDeletion.jobRequestId, deletionPayload.jobRequestId);
  assert.equal(parsedDeletion.deletionRequestId, deletionPayload.deletionRequestId);
});
