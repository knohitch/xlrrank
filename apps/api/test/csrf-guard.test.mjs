import test from "node:test";
import assert from "node:assert/strict";

function context(method, headers = {}) {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ method, headers }),
    }),
  };
}

test("CSRF guard protects public and authenticated unsafe routes unless explicitly exempt", async () => {
  const { CsrfGuard } = await import("../dist/common/guards/csrf.guard.js");

  const protectedReflector = { getAllAndOverride: () => false };
  const guard = new CsrfGuard(protectedReflector);

  assert.throws(
    () => guard.canActivate(context("POST")),
    /CSRF token mismatch/,
  );
  assert.equal(
    guard.canActivate(
      context("POST", {
        cookie: "xlr_csrf=csrf-value",
        "x-csrf-token": "csrf-value",
      }),
    ),
    true,
  );

  const csrfExemptGuard = new CsrfGuard({ getAllAndOverride: () => true });
  assert.equal(csrfExemptGuard.canActivate(context("POST")), true);
  assert.equal(guard.canActivate(context("GET")), true);
});
