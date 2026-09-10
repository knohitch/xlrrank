import test from "node:test";
import assert from "node:assert/strict";

test("queue names cover the event-driven architecture", async () => {
  const m = await import("../dist/index.js");
  assert.deepEqual(
    { ...m.QUEUE_NAMES },
    {
      ingestion: "ingestion",
      intelligence: "intelligence",
      notifications: "notifications",
      modelManagement: "model-management",
      jobs: "jobs",
    },
  );
});

test("social sync job payloads are versioned and identifier-only", async () => {
  const m = await import("../dist/index.js");
  const payload = m.parseSocialConnectionSyncPayload({
    version: 1,
    jobRequestId: "11111111-1111-4111-8111-111111111111",
    connectionId: "22222222-2222-4222-8222-222222222222",
    reason: "MANUAL",
  });
  assert.equal(payload.version, 1);
  assert.equal(payload.reason, "MANUAL");

  assert.throws(
    () =>
      m.parseSocialConnectionSyncPayload({
        version: 2,
        jobRequestId: "11111111-1111-4111-8111-111111111111",
        connectionId: "22222222-2222-4222-8222-222222222222",
        reason: "MANUAL",
      }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      m.parseSocialConnectionSyncPayload({
        version: 1,
        jobRequestId: "11111111-1111-4111-8111-111111111111",
        connectionId: "22222222-2222-4222-8222-222222222222",
        reason: "MANUAL",
        credentials: { accessToken: "secret" },
      }),
    /credential/,
  );
});

test("social sync BullMQ job IDs are deterministic and BullMQ-safe", async () => {
  const m = await import("../dist/index.js");
  const jobId = m.socialSyncBullMqJobId("11111111-1111-4111-8111-111111111111");
  assert.equal(jobId, "social-connection-sync-11111111-1111-4111-8111-111111111111");
  assert.equal(jobId.includes(":"), false);
});

test("provider subscription cleanup payloads are identifier-only", async () => {
  const m = await import("../dist/index.js");
  const payload = m.parseProviderSubscriptionCleanupPayload({
    version: 1,
    jobRequestId: "11111111-1111-4111-8111-111111111111",
    subscriptionId: "33333333-3333-4333-8333-333333333333",
  });
  assert.equal(payload.subscriptionId, "33333333-3333-4333-8333-333333333333");
  assert.throws(
    () =>
      m.parseProviderSubscriptionCleanupPayload({
        version: 1,
        jobRequestId: "11111111-1111-4111-8111-111111111111",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        accessToken: "secret",
      }),
    /credential/,
  );
  assert.equal(
    m.providerSubscriptionCleanupBullMqJobId("11111111-1111-4111-8111-111111111111"),
    "provider-subscription-cleanup-11111111-1111-4111-8111-111111111111",
  );
});
