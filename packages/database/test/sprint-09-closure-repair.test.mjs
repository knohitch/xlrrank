import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateProviderDataDeletionDeadline,
  loadProviderRetentionPolicies,
  MissingApprovedUseCaseRetentionPolicyError,
  claimReconciliationCandidates,
  advanceReconciliationCheckpoint,
  recordReconciliationFailure,
  applyDeletedContentReconciliation,
  applyDeletedInteractionReconciliation,
  applyDeletedAccountAuthorScrubbing,
  markAuthorizationCleanupCompleted,
  markAuthorizationCleanupTerminal,
  createProviderAuthorizationCleanupRequestTx,
} from "../dist/index.js";

function createMockExecutor(handlers = {}) {
  const calls = [];
  const executor = {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql: typeof sql === "string" ? sql : sql.text, params });
      const normalized = (typeof sql === "string" ? sql : sql.text).replace(/\s+/g, " ").trim();
      for (const [pattern, handler] of Object.entries(handlers)) {
        if (new RegExp(pattern, "i").test(normalized)) {
          return typeof handler === "function" ? handler(sql, params) : handler;
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return executor;
}

// ─── DEFECT 1: Approved Use Case Retention Policy (Fail-Closed) ─────────────

test("Retention: loadProviderRetentionPolicies fails closed in production when approved use case is unconfigured", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const mockDb = createMockExecutor({
      "SELECT id, provider_family": {
        rows: [
          {
            id: "policy-1",
            provider_family: "reddit",
            data_category: "reddit_user_content",
            retention_class: "APPROVED_USE_CASE",
            retention_mode: "APPROVED_USE_CASE",
            max_retention_seconds: null,
            description: "Reddit content policy",
            metadata: { approvedUseCaseRequired: true },
          },
        ],
      },
      "SELECT pac.metadata": { rows: [] },
    });

    await assert.rejects(
      () => loadProviderRetentionPolicies("reddit", mockDb, { failClosedOnMissing: true }),
      MissingApprovedUseCaseRetentionPolicyError,
    );
  } finally {
    process.env.NODE_ENV = originalEnv || "test";
  }
});

test("Retention: resolves approved-use-case retention from policy metadata", async () => {
  const mockDb = createMockExecutor({
    "SELECT id, provider_family": {
      rows: [
        {
          id: "policy-reddit-1",
          provider_family: "reddit",
          data_category: "reddit_user_content",
          retention_class: "APPROVED_USE_CASE",
          retention_mode: "APPROVED_USE_CASE",
          max_retention_seconds: null,
          description: "Reddit content policy",
          metadata: { approvedUseCaseRequired: true, approvedUseCaseRetentionSeconds: 2592000 },
        },
      ],
    },
    "SELECT pac.metadata": { rows: [] },
  });

  const policies = await loadProviderRetentionPolicies("reddit", mockDb, { failClosedOnMissing: true });
  assert.equal(policies.length, 1);
  assert.equal(policies[0].maxRetentionSeconds, 2592000);
  assert.equal(policies[0].retentionMode, "APPROVED_USE_CASE");
});

test("Retention: resolves approved-use-case retention from app config metadata", async () => {
  const mockDb = createMockExecutor({
    "SELECT id, provider_family": {
      rows: [
        {
          id: "policy-reddit-1",
          provider_family: "reddit",
          data_category: "reddit_user_content",
          retention_class: "APPROVED_USE_CASE",
          retention_mode: "APPROVED_USE_CASE",
          max_retention_seconds: null,
          description: "Reddit content policy",
          metadata: { approvedUseCaseRequired: true },
        },
      ],
    },
    "SELECT pac.metadata": {
      rows: [
        {
          metadata: {
            retention: {
              approvedUseCaseRetentionSeconds: 1209600,
            },
          },
        },
      ],
    },
  });

  const policies = await loadProviderRetentionPolicies("reddit", mockDb, { failClosedOnMissing: true });
  assert.equal(policies.length, 1);
  assert.equal(policies[0].maxRetentionSeconds, 1209600);
});

test("Retention: resolves approved-use-case retention from environment variable", async () => {
  process.env.PROVIDER_APPROVED_USE_CASE_RETENTION_SECONDS_REDDIT = "604800";
  try {
    const mockDb = createMockExecutor({
      "SELECT id, provider_family": {
        rows: [
          {
            id: "policy-reddit-1",
            provider_family: "reddit",
            data_category: "reddit_user_content",
            retention_class: "APPROVED_USE_CASE",
            retention_mode: "APPROVED_USE_CASE",
            max_retention_seconds: null,
            description: "Reddit content policy",
            metadata: { approvedUseCaseRequired: true },
          },
        ],
      },
      "SELECT pac.metadata": { rows: [] },
    });

    const policies = await loadProviderRetentionPolicies("reddit", mockDb, { failClosedOnMissing: true });
    assert.equal(policies.length, 1);
    assert.equal(policies[0].maxRetentionSeconds, 604800);
  } finally {
    delete process.env.PROVIDER_APPROVED_USE_CASE_RETENTION_SECONDS_REDDIT;
  }
});

// ─── DEFECT 3: Data Deletion Deadline & Durable Request ─────────────────────

test("Data Deletion: calculateProviderDataDeletionDeadline calculates 10-day deadline from Reddit policy metadata", async () => {
  const mockDb = createMockExecutor({
    "SELECT metadata": {
      rows: [
        {
          metadata: {
            dpaDeletionDeadlineDays: 10,
            deletionRequestDeadlineSeconds: 864000,
          },
        },
      ],
    },
  });

  const requestedAt = new Date("2026-09-01T00:00:00.000Z");
  const deadline = await calculateProviderDataDeletionDeadline("reddit", requestedAt, mockDb);
  assert.equal(deadline.toISOString(), "2026-09-11T00:00:00.000Z"); // Exactly 10 days later
});

test("Data Deletion: calculateProviderDataDeletionDeadline defaults to 30 days for providers without metadata", async () => {
  const mockDb = createMockExecutor({
    "SELECT metadata": { rows: [] },
  });

  const requestedAt = new Date("2026-09-01T00:00:00.000Z");
  const deadline = await calculateProviderDataDeletionDeadline("unknown_provider", requestedAt, mockDb);
  assert.equal(deadline.toISOString(), "2026-10-01T00:00:00.000Z"); // 30 days later
});

// ─── DEFECT 2: Reconciliation & Scrubbing ───────────────────────────────────

test("Reconciliation: claimReconciliationCandidates uses FOR UPDATE SKIP LOCKED and cursor filtering", async () => {
  const mockClient = createMockExecutor({
    "INSERT INTO provider_reconciliation_checkpoints": {
      rows: [{ id: "cp-1", last_processed_id: "prev-id" }],
    },
    "SELECT sci.id, sci.external_id": {
      rows: [
        {
          id: "item-1",
          external_id: "t3_post1",
          author_external_id: "t2_user1",
          author_handle: "author1",
          metadata: {},
        },
      ],
    },
  });

  const res = await claimReconciliationCandidates(mockClient, {
    connectionId: "conn-1",
    scopeId: "scope-1",
    providerFamily: "reddit",
    entityType: "CONTENT",
    limit: 10,
  });

  assert.equal(res.checkpointId, "cp-1");
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].externalId, "t3_post1");

  const queryCall = mockClient.calls.find((c) => c.sql.includes("FOR UPDATE OF sci SKIP LOCKED"));
  assert.ok(queryCall, "Expected FOR UPDATE OF sci SKIP LOCKED query");
  assert.ok(queryCall.sql.includes("AND sci.id > $4"), "Expected cursor comparison query");
});

test("Reconciliation: advanceReconciliationCheckpoint updates status to IDLE and saves cursor", async () => {
  const mockClient = createMockExecutor({
    "UPDATE provider_reconciliation_checkpoints": { rowCount: 1, rows: [] },
  });

  await advanceReconciliationCheckpoint(mockClient, {
    checkpointId: "cp-1",
    lastProcessedId: "item-50",
    hasMore: true,
    metadata: { batchSize: 50 },
  });

  const updateCall = mockClient.calls.find((c) => c.sql.includes("UPDATE provider_reconciliation_checkpoints"));
  assert.ok(updateCall);
  assert.equal(updateCall.params[0], "cp-1");
  assert.equal(updateCall.params[1], "item-50");
});

test("Reconciliation: recordReconciliationFailure records error and sets status to FAILED", async () => {
  const mockClient = createMockExecutor({
    "UPDATE provider_reconciliation_checkpoints": { rowCount: 1, rows: [] },
  });

  await recordReconciliationFailure(mockClient, "cp-1", new Error("Rate limit exceeded"));

  const updateCall = mockClient.calls.find((c) => c.sql.includes("UPDATE provider_reconciliation_checkpoints"));
  assert.ok(updateCall);
  assert.ok(updateCall.sql.includes("status = 'FAILED'"));
  assert.equal(updateCall.params[0], "cp-1");
});

test("Reconciliation: applyDeletedContentReconciliation removes observation and checks orphans", async () => {
  const mockClient = createMockExecutor({
    "DELETE FROM social_content_observations": { rowCount: 1, rows: [] },
    "DELETE FROM social_content_items": { rowCount: 1, rows: [] },
  });

  const result = await applyDeletedContentReconciliation(mockClient, {
    contentItemId: "item-1",
    connectionId: "conn-1",
    scopeId: "scope-1",
  });

  assert.equal(result.observationDeleted, true);
  assert.equal(result.itemDeleted, true);

  const orphanDel = mockClient.calls.find((c) => c.sql.includes("DELETE FROM social_content_items"));
  assert.ok(orphanDel);
  assert.ok(orphanDel.sql.includes("NOT EXISTS"));
});

test("Reconciliation: applyDeletedInteractionReconciliation removes interaction observation and checks orphans", async () => {
  const mockClient = createMockExecutor({
    "DELETE FROM social_interaction_observations": { rowCount: 1, rows: [] },
    "DELETE FROM social_interactions": { rowCount: 1, rows: [] },
  });

  const result = await applyDeletedInteractionReconciliation(mockClient, {
    interactionId: "interaction-1",
    connectionId: "conn-1",
    scopeId: "scope-1",
  });

  assert.equal(result.observationDeleted, true);
  assert.equal(result.interactionDeleted, true);
});

test("Reconciliation: applyDeletedAccountAuthorScrubbing scrubs posts, comments, and sanitizes account", async () => {
  const mockClient = createMockExecutor({
    "UPDATE social_content_items": { rowCount: 3, rows: [] },
    "UPDATE social_interactions": { rowCount: 5, rows: [] },
    "UPDATE social_external_accounts": { rowCount: 1, rows: [] },
    "DELETE FROM social_account_handles": { rowCount: 1, rows: [] },
  });

  const result = await applyDeletedAccountAuthorScrubbing(mockClient, {
    authorExternalId: "t2_deleted_user",
    providerFamily: "reddit",
  });

  assert.equal(result.contentScrubbed, 3);
  assert.equal(result.interactionsScrubbed, 5);
  assert.equal(result.accountsSanitized, 1);

  const contentUpdate = mockClient.calls.find((c) => c.sql.includes("UPDATE social_content_items"));
  assert.ok(contentUpdate.sql.includes("author_handle = '[deleted]'"));
  assert.ok(contentUpdate.sql.includes("author_external_id = NULL"));
});

// ─── DEFECT 4: Authorization Cleanup Wiping & Idempotency ───────────────────

test("Authorization Cleanup: markAuthorizationCleanupCompleted sets COMPLETED and clears credentials_encrypted", async () => {
  const mockClient = createMockExecutor({
    "UPDATE provider_authorization_cleanups": { rowCount: 1, rows: [] },
    "UPDATE jobs": { rowCount: 1, rows: [] },
  });

  await markAuthorizationCleanupCompleted("cleanup-1", "job-1", mockClient);

  const cleanupUpdate = mockClient.calls.find((c) => c.sql.includes("UPDATE provider_authorization_cleanups"));
  assert.ok(cleanupUpdate);
  assert.ok(cleanupUpdate.sql.includes("credentials_encrypted = NULL"));
  assert.ok(cleanupUpdate.sql.includes("status = 'COMPLETED'"));

  const jobUpdate = mockClient.calls.find((c) => c.sql.includes("UPDATE jobs"));
  assert.ok(jobUpdate);
  assert.ok(jobUpdate.sql.includes("status = 'COMPLETED'"));
});

test("Authorization Cleanup: markAuthorizationCleanupTerminal sets DEAD_LETTERED and clears credentials_encrypted", async () => {
  const mockClient = createMockExecutor({
    "UPDATE provider_authorization_cleanups": { rowCount: 1, rows: [] },
    "UPDATE jobs": { rowCount: 1, rows: [] },
  });

  await markAuthorizationCleanupTerminal("cleanup-1", "job-1", new Error("Token permanently revoked"), mockClient);

  const cleanupUpdate = mockClient.calls.find((c) => c.sql.includes("UPDATE provider_authorization_cleanups"));
  assert.ok(cleanupUpdate);
  assert.ok(cleanupUpdate.sql.includes("credentials_encrypted = NULL"));
  assert.ok(cleanupUpdate.sql.includes("status = 'DEAD_LETTERED'"));

  const jobUpdate = mockClient.calls.find((c) => c.sql.includes("UPDATE jobs"));
  assert.ok(jobUpdate);
  assert.ok(jobUpdate.sql.includes("status = 'DEAD_LETTERED'"));
});

test("Authorization Cleanup: createProviderAuthorizationCleanupRequestTx detects duplicate active cleanup", async () => {
  const mockClient = createMockExecutor({
    "SELECT id, status": {
      rows: [{ id: "existing-job-id", status: "PENDING_DISPATCH" }],
    },
    "SELECT id FROM provider_authorization_cleanups": {
      rows: [{ id: "existing-cleanup-id" }],
    },
  });

  const result = await createProviderAuthorizationCleanupRequestTx(mockClient, {
    connectionId: "conn-123",
    scopeId: "scope-123",
    platformId: "plat-123",
    providerFamily: "reddit",
    credentialsEncrypted: "enc-secret",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.duplicate, true);
  assert.equal(result.jobId, "existing-job-id");
  assert.equal(result.cleanupId, "existing-cleanup-id");
});
