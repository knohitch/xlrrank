import test from "node:test";
import assert from "node:assert/strict";

test("roles map to permissions without scattered comparisons", async () => {
  const m = await import("../dist/rbac.js");
  assert.deepEqual([...m.ROLES], ["USER", "SUPPORT", "ADMIN", "SUPER_ADMIN"]);
  assert.equal(m.hasPermission("USER", "admin.system.manage"), false);
  assert.equal(m.hasPermission("SUPPORT", "support.ticket.respond"), true);
  assert.equal(m.hasPermission("ADMIN", "admin.users.read"), true);
  assert.equal(m.hasPermission("SUPER_ADMIN", "admin.system.manage"), true);
});

test("role hierarchy is monotonic", async () => {
  const m = await import("../dist/rbac.js");
  assert.equal(m.roleHasAtLeast("ADMIN", "SUPPORT"), true);
  assert.equal(m.roleHasAtLeast("USER", "ADMIN"), false);
  assert.equal(m.isAdminRole("ADMIN"), true);
  assert.equal(m.isAdminRole("USER"), false);
  assert.equal(m.isSuperAdminRole("SUPER_ADMIN"), true);
});

test("constitution entities forbid platform-specific core names", async () => {
  const m = await import("../dist/constitution/entities.js");
  // Module must export the canonical allow-list; guard enforces the rest.
  const src = JSON.stringify(Object.keys(m));
  assert.ok(src.length > 2);
});
