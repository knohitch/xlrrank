import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSearchIndex,
  mergeCrossPlatformProfiles,
  normalizePlatformMetrics,
  search,
} from "../dist/index.js";

test("Sprint 16 cross-platform merge requires verified identity evidence and preserves provenance", () => {
  assert.throws(
    () =>
      mergeCrossPlatformProfiles([
        { platform: "x", externalId: "1", handle: "sam", displayName: "Sam Example" },
        { platform: "linkedin", externalId: "2", handle: "sam", displayName: "Sam Example" },
      ]),
    /verified canonical identity/,
  );

  const merged = mergeCrossPlatformProfiles([
    {
      platform: "linkedin",
      externalId: "in-1",
      handle: "ada",
      displayName: "Ada",
      canonicalPersonId: "person-1",
      followerCount: "UNKNOWN",
      identityEvidence: { confidence: "HIGH", evidenceIds: ["candidate-1"] },
      metadata: { provider: "linkedin" },
    },
    {
      platform: "x",
      externalId: "x-1",
      handle: "ada",
      displayName: "Ada",
      canonicalPersonId: "person-1",
      followerCount: 100,
      identityEvidence: { confidence: "HIGH", evidenceIds: ["candidate-1"] },
      metadata: { provider: "x" },
    },
  ]);
  assert.equal(merged.personId, "person-1");
  assert.deepEqual(
    merged.accounts.map((account) => account.platform),
    ["linkedin", "x"],
  );
  assert.deepEqual(merged.mergeEvidence, ["candidate-1", "candidate-1"]);
  assert.equal(merged.platformEvidence.x.provider, "x");
});

test("Sprint 16 provider metrics are normalized explicitly with zero, unknown and incomparable semantics", () => {
  const normalized = normalizePlatformMetrics(
    {
      likes: 0,
      reposts: 4,
      impressions: "UNKNOWN",
      platformOnlyScore: 99,
    },
    [
      {
        providerMetric: "likes",
        normalizedKind: "reaction",
        semanticVersion: "v1",
        comparable: true,
      },
      {
        providerMetric: "reposts",
        normalizedKind: "share",
        semanticVersion: "v1",
        comparable: true,
      },
      {
        providerMetric: "impressions",
        normalizedKind: "view",
        semanticVersion: "v1",
        comparable: true,
      },
      {
        providerMetric: "platformOnlyScore",
        normalizedKind: "unknown",
        semanticVersion: "v1",
        comparable: false,
      },
    ],
  );
  assert.deepEqual(normalized.values, { reaction: 0, share: 4 });
  assert.deepEqual(normalized.unknown, ["view"]);
  assert.deepEqual(normalized.incomparable, ["platformOnlyScore"]);
  assert.equal(normalized.version, "v1");
});

test("Sprint 16 global search applies tenant authorization before pagination and strips sensitive metadata", () => {
  const index = buildSearchIndex([
    {
      type: "person",
      id: "a-1",
      tenantId: "tenant-a",
      name: "Ada Automation",
      description: "AI workflow builder",
      tags: ["ai"],
      platform: "x",
      topics: ["automation"],
      updatedAt: "2032-01-02T00:00:00.000Z",
      visibility: "TENANT",
      metadata: { safe: true, accessToken: "secret", rawProviderPayload: { private: true } },
    },
    {
      type: "person",
      id: "b-1",
      tenantId: "tenant-b",
      name: "Ada Automation",
      description: "AI workflow builder",
      tags: ["ai"],
      platform: "linkedin",
      topics: ["automation"],
      updatedAt: "2032-01-02T00:00:00.000Z",
      visibility: "TENANT",
    },
    {
      type: "content",
      id: "deleted-1",
      tenantId: "tenant-a",
      name: "Ada Automation",
      description: "Deleted content",
      tags: ["ai"],
      platform: "x",
      topics: ["automation"],
      updatedAt: "2032-01-02T00:00:00.000Z",
      visibility: "DELETED",
      deleted: true,
    },
  ]);

  const result = search(
    {
      text: "Ada automation",
      pageSize: 10,
      filters: { entityTypes: ["person"], platforms: ["x"], topics: ["automation"] },
    },
    index,
    { tenantId: "tenant-a", userId: "user-a" },
  );
  assert.equal(result.total, 1);
  assert.equal(result.results[0].entityId, "a-1");
  assert.equal(result.results[0].metadata.safe, true);
  assert.equal("accessToken" in result.results[0].metadata, false);
  assert.equal("rawProviderPayload" in result.results[0].metadata, false);

  const tenantB = search({ text: "Ada automation", pageSize: 10 }, index, {
    tenantId: "tenant-b",
    userId: "user-b",
  });
  assert.deepEqual(
    tenantB.results.map((item) => item.entityId),
    ["b-1"],
  );
});

test("Sprint 16 search pagination is stable and cursor-bound to query/filter/tenant/user", () => {
  const index = buildSearchIndex([
    {
      type: "person",
      id: "1",
      tenantId: "tenant-a",
      name: "AI Alpha",
      visibility: "TENANT",
      updatedAt: "2032-01-01T00:00:00.000Z",
    },
    {
      type: "person",
      id: "2",
      tenantId: "tenant-a",
      name: "AI Beta",
      visibility: "TENANT",
      updatedAt: "2032-01-01T00:00:00.000Z",
    },
    {
      type: "person",
      id: "3",
      tenantId: "tenant-a",
      name: "AI Gamma",
      visibility: "TENANT",
      updatedAt: "2032-01-01T00:00:00.000Z",
    },
  ]);

  const first = search({ text: "AI", pageSize: 2 }, index, {
    tenantId: "tenant-a",
    userId: "user-a",
    maxPageSize: 2,
  });
  assert.deepEqual(
    first.results.map((result) => result.entityId),
    ["1", "2"],
  );
  assert.ok(first.nextCursor);

  const second = search({ text: "AI", pageSize: 2, cursor: first.nextCursor }, index, {
    tenantId: "tenant-a",
    userId: "user-a",
    maxPageSize: 2,
  });
  assert.deepEqual(
    second.results.map((result) => result.entityId),
    ["3"],
  );
  assert.equal(second.nextCursor, undefined);

  assert.throws(
    () =>
      search({ text: "AI", pageSize: 2, cursor: first.nextCursor }, index, {
        tenantId: "tenant-b",
        userId: "user-a",
      }),
    /cursor/,
  );
  assert.throws(
    () =>
      search({ text: "AI".repeat(200), pageSize: 2 }, index, {
        tenantId: "tenant-a",
        maxQueryLength: 20,
      }),
    /maximum length/,
  );
});
