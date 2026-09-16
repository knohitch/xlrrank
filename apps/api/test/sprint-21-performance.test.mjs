import test from "node:test";
import assert from "node:assert/strict";

test("config schema defines bounded SOCIAL_SYNC_MAX_PAGES_PER_RUN", async () => {
  const { envSchema } = await import("@xlrrank/config");
  const parsed = envSchema.parse({});
  assert.equal(parsed.SOCIAL_SYNC_MAX_PAGES_PER_RUN, 50);

  const custom = envSchema.parse({ SOCIAL_SYNC_MAX_PAGES_PER_RUN: "25" });
  assert.equal(custom.SOCIAL_SYNC_MAX_PAGES_PER_RUN, 25);

  const invalid = envSchema.safeParse({ SOCIAL_SYNC_MAX_PAGES_PER_RUN: "2000" });
  assert.equal(invalid.success, false);
});

test("getRolesForUsers returns empty map for empty input without executing queries", async () => {
  const { getRolesForUsers } = await import("@xlrrank/database");
  const result = await getRolesForUsers([]);
  assert.equal(result instanceof Map, true);
  assert.equal(result.size, 0);
});

test("AiGateway fails closed on unregistered provider without mock or fake fallback", async () => {
  const { AiGateway } = await import("../../../packages/ai-core/dist/index.js");
  const gateway = new AiGateway();
  await assert.rejects(
    () =>
      gateway.generateText("nonexistent-provider", {
        messages: [{ role: "user", content: "test" }],
      }),
    /Provider 'nonexistent-provider' not registered/,
  );
  await assert.rejects(
    () =>
      gateway.generateStructured("nonexistent-provider", {
        messages: [{ role: "user", content: "test" }],
        schema: { type: "object" },
      }),
    /Provider 'nonexistent-provider' not registered/,
  );
});

test("notifications controller rejects unbounded or invalid limits", async () => {
  const { NotificationsController } =
    await import("../dist/notifications/notifications.controller.js");
  const controller = new NotificationsController({
    list: async () => [],
    unreadCount: async () => 0,
    markRead: async () => {},
    markAllRead: async () => {},
  });

  const auth = { userId: "00000000-0000-0000-0000-000000000001", roles: ["USER"] };
  await assert.rejects(
    () => controller.list(auth, undefined, "1000"),
    /limit must be an integer between 1 and 100/,
  );
  await assert.rejects(
    () => controller.list(auth, undefined, "-5"),
    /limit must be an integer between 1 and 100/,
  );
  await assert.rejects(
    () => controller.list(auth, undefined, "invalid"),
    /limit must be an integer between 1 and 100/,
  );
});

test("support controller rejects unbounded or invalid limits", async () => {
  const { SupportController } = await import("../dist/support/support.controller.js");
  const controller = new SupportController({
    listOwnTickets: async () => [],
    listAllTickets: async () => [],
  });

  const auth = { userId: "00000000-0000-0000-0000-000000000001", roles: ["USER"] };
  await assert.rejects(
    () => controller.listTickets(auth, undefined, "500"),
    /limit must be an integer between 1 and 100/,
  );
  await assert.rejects(
    () => controller.listTickets(auth, undefined, "0"),
    /limit must be an integer between 1 and 100/,
  );
});
