import test from "node:test";
import assert from "node:assert/strict";

const billing = await import("../dist/billing/billing.service.js");
const aiCost = await import("../dist/billing/ai-cost.service.js");

test("billing entitlements fail closed for unknown, expired, and inactive provider states", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  assert.equal(billing.resolveEntitlements(null, now).ai.byok, false);
  assert.equal(
    billing.resolveEntitlements({ planId: "pro", status: "PAST_DUE" }, now).api.access,
    false,
  );
  assert.equal(
    billing.resolveEntitlements({ planId: "pro", status: "UNKNOWN" }, now).api.access,
    false,
  );
  assert.equal(
    billing.resolveEntitlements(
      { planId: "pro", status: "ACTIVE", currentPeriodEnd: "2026-09-11T12:00:00Z" },
      now,
    ).api.access,
    false,
  );
  assert.equal(
    billing.resolveEntitlements(
      { planId: "enterprise", status: "TRIALING", trialEndsAt: "2026-09-11T12:00:00Z" },
      now,
    ).api.access,
    false,
  );
});

test("billing entitlements grant only explicitly active or unexpired trial state", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  assert.equal(
    billing.resolveEntitlements(
      { planId: "pro", status: "ACTIVE", currentPeriodEnd: "2026-09-13T12:00:00Z" },
      now,
    ).api.access,
    true,
  );
  assert.equal(
    billing.resolveEntitlements(
      { planId: "starter", status: "TRIAL", trialEndsAt: "2026-09-13T12:00:00Z" },
      now,
    ).ai.byok,
    true,
  );
  assert.equal(
    billing.resolveEntitlements({ planId: "made-up-plan", status: "ACTIVE" }, now).api.access,
    false,
  );
});

test("billing usage charges reject malformed metrics and non-positive amounts", () => {
  assert.doesNotThrow(() => billing.validateUsageCharge("ai.tokens", 1));
  assert.throws(() => billing.validateUsageCharge("AI TOKENS", 1), /Invalid billing usage metric/);
  assert.throws(() => billing.validateUsageCharge("ai.tokens", 0), /Invalid billing usage amount/);
  assert.throws(() => billing.validateUsageCharge("ai.tokens", -1), /Invalid billing usage amount/);
});

test("AI usage accounting rejects poisoned counters and uses UTC day windows", () => {
  assert.doesNotThrow(() =>
    aiCost.validateAiUsageAccounting({ promptTokens: 1, completionTokens: 2, costEstimate: 0.01 }),
  );
  assert.throws(
    () => aiCost.validateAiUsageAccounting({ promptTokens: -1, completionTokens: 2 }),
    /Invalid AI token/,
  );
  assert.throws(
    () =>
      aiCost.validateAiUsageAccounting({
        promptTokens: 1,
        completionTokens: 2,
        costEstimate: -0.01,
      }),
    /Invalid AI usage cost/,
  );
  assert.equal(
    aiCost.utcDayStart(new Date("2026-09-12T23:59:59-05:00")).toISOString(),
    "2026-09-13T00:00:00.000Z",
  );
});
