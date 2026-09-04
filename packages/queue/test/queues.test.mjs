import test from "node:test";
import assert from "node:assert/strict";

test("queue names cover the event-driven architecture", async () => {
  const m = await import("../dist/index.js");
  assert.deepEqual({ ...m.QUEUE_NAMES }, {
    ingestion: "ingestion",
    intelligence: "intelligence",
    notifications: "notifications",
    modelManagement: "model-management",
    jobs: "jobs",
  });
});
