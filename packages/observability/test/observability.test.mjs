import test from "node:test";
import assert from "node:assert/strict";

test("metrics increment/gauge/snapshot/reset", async () => {
  // getMetrics is pure and must not require env/redis.
  const { getMetrics } = await import("../dist/index.js");
  const metrics = getMetrics();
  metrics.increment("jobs.processed");
  metrics.increment("jobs.processed", 2);
  metrics.gauge("queue.depth", 7);
  assert.deepEqual(metrics.snapshot(), { "jobs.processed": 3, "queue.depth": 7 });
  metrics.reset();
  assert.deepEqual(metrics.snapshot(), {});
});
