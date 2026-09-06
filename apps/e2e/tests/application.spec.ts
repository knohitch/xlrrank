import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { Pool } from "pg";
import { tokenHash } from "@xlrrank/auth";
import {
  FixedWindowRateLimiter,
  RedisRateLimiterStore,
} from "../../api/src/common/rate-limiter.js";
import { closeConnections } from "@xlrrank/queue";

const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000";
const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";
const DATABASE_URL = process.env.DATABASE_URL;
const FIXTURE_PASSWORD = "E2ePass123!";

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required for application E2E tests.");
}

const databaseName = new URL(DATABASE_URL).pathname.slice(1);
if (!databaseName.includes("xlrrank_e2e")) {
  throw new Error(`Refusing to run application E2E against non-E2E database: ${databaseName}`);
}

const pool = new Pool({ connectionString: DATABASE_URL });

test.afterAll(async () => {
  await pool.end();
  await closeConnections();
});

async function csrf(api: APIRequestContext) {
  const response = await api.get("/api/auth/csrf");
  expect(response.ok()).toBeTruthy();
  const data = (await response.json()) as { csrfToken: string };
  expect(data.csrfToken).toBeTruthy();
  return data.csrfToken;
}

async function apiPost(api: APIRequestContext, path: string, data: unknown) {
  const token = await csrf(api);
  return api.post(`/api${path}`, {
    data,
    headers: { "X-CSRF-Token": token },
  });
}

async function apiPatch(api: APIRequestContext, path: string, data: unknown) {
  const token = await csrf(api);
  return api.patch(`/api${path}`, {
    data,
    headers: { "X-CSRF-Token": token },
  });
}

async function apiPut(api: APIRequestContext, path: string, data: unknown) {
  const token = await csrf(api);
  return api.put(`/api${path}`, {
    data,
    headers: { "X-CSRF-Token": token },
  });
}

async function apiDelete(api: APIRequestContext, path: string) {
  const token = await csrf(api);
  return api.delete(`/api${path}`, {
    headers: { "X-CSRF-Token": token },
  });
}

async function signin(email: string, password = FIXTURE_PASSWORD) {
  const api = await request.newContext({ baseURL: WEB_URL });
  const response = await apiPost(api, "/auth/signin", { email, password });
  expect(response.status()).toBe(200);
  return api;
}

async function getUserByEmail(email: string) {
  const result = await pool.query<{
    id: string;
    email: string;
    status: string;
    password_hash: string;
    display_name: string;
  }>("SELECT id, email, status, password_hash, display_name FROM users WHERE email = $1", [
    email.toLowerCase(),
  ]);
  return result.rows[0] ?? null;
}

async function insertExpiredToken(userId: string, purpose: string, rawToken: string) {
  await pool.query(
    `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() - interval '1 minute')`,
    [userId, purpose, tokenHash(rawToken)],
  );
}

async function waitForMail(to: string, subject: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const listResponse = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`);
    if (listResponse.ok) {
      const list = (await listResponse.json()) as {
        messages?: Array<Record<string, unknown>>;
        Messages?: Array<Record<string, unknown>>;
      };
      const messages = list.messages ?? list.Messages ?? [];
      const summary = messages.find((item) => {
        const recipients = JSON.stringify(item.To ?? item.to ?? "");
        return (
          recipients.includes(to) && String(item.Subject ?? item.subject ?? "").includes(subject)
        );
      });
      const id = summary?.ID ?? summary?.Id ?? summary?.id;
      if (id) {
        const messageResponse = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`);
        expect(messageResponse.ok).toBeTruthy();
        const message = (await messageResponse.json()) as Record<string, unknown>;
        const text = String(message.Text ?? message.text ?? message.HTML ?? message.html ?? "");
        const url = text.match(/https?:\/\/[^\s<"]+/)?.[0];
        if (url) return url;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${subject} email to ${to}`);
}

async function signupThroughBrowser(page: Page, email: string, password: string) {
  await page.goto("/signup");
  await page.getByLabel("Display Name").fill("Sprint Three User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByText("Account created")).toBeVisible();
}

test("signup, verification, session, profile, password reset, and signout work end to end", async ({
  page,
  context,
}) => {
  const email = `sprint03-${Date.now()}@xlrrank.test`;
  const password = "StartPass123!";
  const changedPassword = "ChangedPass123!";
  const resetPassword = "ResetPass123!";

  await signupThroughBrowser(page, email, password);
  const pendingUser = await getUserByEmail(email);
  expect(pendingUser?.status).toBe("PENDING_VERIFICATION");

  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Please verify your email address before signing in.")).toBeVisible();

  const duplicate = await apiPost(await request.newContext({ baseURL: WEB_URL }), "/auth/signup", {
    email,
    password,
    displayName: "Duplicate User",
  });
  expect(duplicate.status()).toBe(409);

  const invalidEmail = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/signup",
    {
      email: "not-an-email",
      password,
      displayName: "Invalid User",
    },
  );
  expect(invalidEmail.status()).toBe(400);

  const weakPassword = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/signup",
    {
      email: `weak-${email}`,
      password: "password",
      displayName: "Weak User",
    },
  );
  expect(weakPassword.status()).toBe(400);

  const invalidName = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/signup",
    {
      email: `name-${email}`,
      password,
      displayName: "A",
    },
  );
  expect(invalidName.status()).toBe(400);

  const noCsrf = await request.newContext({ baseURL: WEB_URL });
  const csrfFailure = await noCsrf.post("/api/auth/signup", {
    data: { email: `csrf-${email}`, password, displayName: "CSRF User" },
  });
  expect(csrfFailure.status()).toBe(403);

  const invalidVerify = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/verify-email",
    {
      token: "invalid-token",
    },
  );
  expect(invalidVerify.status()).toBe(400);

  await insertExpiredToken(pendingUser!.id, "verify_email", "expired-verify-token");
  const expiredVerify = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/verify-email",
    {
      token: "expired-verify-token",
    },
  );
  expect(expiredVerify.status()).toBe(400);

  const verificationUrl = await waitForMail(email, "Verify your XLRrank account");
  await page.goto(verificationUrl);
  await expect(page.getByText("Email verified")).toBeVisible();
  expect((await getUserByEmail(email))?.status).toBe("ACTIVE");

  const reusedVerify = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/verify-email",
    {
      token: new URL(verificationUrl).searchParams.get("token"),
    },
  );
  expect(reusedVerify.status()).toBe(400);

  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: /Welcome, Sprint Three User/ })).toBeVisible();

  const cookies = await context.cookies(WEB_URL);
  const sessionCookie = cookies.find((cookie) => cookie.name === "xlr_session");
  const csrfCookie = cookies.find((cookie) => cookie.name === "xlr_csrf");
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.secure).toBe(true);
  expect(sessionCookie?.sameSite).toBe("None");
  expect(sessionCookie?.path).toBe("/");
  expect(csrfCookie?.httpOnly).toBe(false);
  await expect.poll(() => page.evaluate(() => document.cookie.includes("xlr_session"))).toBe(false);

  await page.reload();
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();

  await page.goto("/settings");
  await page.getByLabel("Display Name").fill("Sprint Three Renamed");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  expect((await getUserByEmail(email))?.display_name).toBe("Sprint Three Renamed");
  await page.reload();
  await expect(page.getByLabel("Display Name")).toHaveValue("Sprint Three Renamed");

  await page.goto("/support");
  await page.getByLabel("Subject").fill("Browser support ticket");
  await page.getByLabel("Category").fill("account");
  await page.getByLabel("Message").fill("This ticket was created by the browser journey.");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByText("Ticket created.")).toBeVisible();
  await page.getByRole("button", { name: "Browser support ticket" }).click();
  await page.getByLabel("Reply").fill("Browser user reply");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText("Browser user reply")).toBeVisible();

  await page.goto("/settings");
  await page.getByLabel("Current password").fill("wrong-password");
  await page.getByLabel("New password").fill(changedPassword);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Current password is incorrect.")).toBeVisible();
  const beforeHash = (await getUserByEmail(email))?.password_hash;
  await page.getByLabel("Current password").fill(password);
  await page.getByLabel("New password").fill(changedPassword);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed. Other sessions were revoked.")).toBeVisible();
  expect((await getUserByEmail(email))?.password_hash).not.toBe(beforeHash);

  const oldSignin = await apiPost(await request.newContext({ baseURL: WEB_URL }), "/auth/signin", {
    email,
    password,
  });
  expect(oldSignin.status()).toBe(401);
  await (await signin(email, changedPassword)).dispose();

  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(
    page.getByText("If that email is registered, a reset link has been sent."),
  ).toBeVisible();
  const resetUrl = await waitForMail(email, "Reset your XLRrank password");

  await insertExpiredToken(pendingUser!.id, "reset_password", "expired-reset-token");
  const expiredReset = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/reset-password",
    {
      token: "expired-reset-token",
      password: resetPassword,
    },
  );
  expect(expiredReset.status()).toBe(400);

  const wrongPurposeReset = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/reset-password",
    {
      token: new URL(verificationUrl).searchParams.get("token"),
      password: resetPassword,
    },
  );
  expect(wrongPurposeReset.status()).toBe(400);

  await page.goto(resetUrl);
  await page.getByLabel("New Password").fill(resetPassword);
  await page.getByLabel("Confirm Password").fill(resetPassword);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("Password reset!")).toBeVisible();

  const reusedReset = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/reset-password",
    {
      token: new URL(resetUrl).searchParams.get("token"),
      password: "AnotherPass123!",
    },
  );
  expect(reusedReset.status()).toBe(400);

  const changedSignin = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/signin",
    {
      email,
      password: changedPassword,
    },
  );
  expect(changedSignin.status()).toBe(401);
  await (await signin(email, resetPassword)).dispose();

  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(resetPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/signin/);
});

test("sessions, CSRF, rate limiting, and account deletion are enforced by the API", async () => {
  const user = await signin("e2e-user@xlrrank.test");
  const second = await signin("e2e-user@xlrrank.test");
  const other = await signin("e2e-support@xlrrank.test");

  const sessionsResponse = await user.get("/api/auth/sessions");
  expect(sessionsResponse.status()).toBe(200);
  const sessions = (await sessionsResponse.json()) as {
    sessions: Array<{ id: string; current: boolean }>;
  };
  expect(sessions.sessions.length).toBeGreaterThanOrEqual(2);
  expect(sessions.sessions.filter((item) => item.current)).toHaveLength(1);
  const otherSession = sessions.sessions.find((item) => !item.current);
  expect(otherSession).toBeTruthy();
  expect((await apiDelete(user, `/auth/sessions/${otherSession!.id}`)).status()).toBe(204);
  expect((await second.get("/api/auth/me")).status()).toBe(401);

  const supportSessions = await other.get("/api/auth/sessions");
  const supportSession = ((await supportSessions.json()) as { sessions: Array<{ id: string }> })
    .sessions[0];
  if (!supportSession) throw new Error("Expected support fixture to have a current session.");
  expect((await apiDelete(user, `/auth/sessions/${supportSession.id}`)).status()).toBe(204);
  expect((await other.get("/api/auth/me")).status()).toBe(200);

  const csrfToken = await csrf(user);
  const mismatched = await user.patch("/api/users/me", {
    data: { displayName: "Mismatched CSRF" },
    headers: { "X-CSRF-Token": `${csrfToken}-wrong` },
  });
  expect(mismatched.status()).toBe(403);
  expect((await apiPatch(user, "/users/me", { displayName: "API Profile Name" })).status()).toBe(
    200,
  );

  const unknownRecovery = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/forgot-password",
    {
      email: "missing@xlrrank.test",
    },
  );
  const knownRecovery = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/forgot-password",
    {
      email: "e2e-user@xlrrank.test",
    },
  );
  expect(unknownRecovery.status()).toBe(200);
  expect(knownRecovery.status()).toBe(200);
  expect(await unknownRecovery.json()).toEqual(await knownRecovery.json());

  const limited = await request.newContext({ baseURL: WEB_URL });
  const signinLimit = Number(process.env.RATE_LIMIT_SIGNIN_LIMIT ?? 10);
  for (let i = 0; i < signinLimit; i += 1) {
    await apiPost(limited, "/auth/signin", {
      email: "limited@xlrrank.test",
      password: "wrong",
    });
  }
  const rateLimited = await apiPost(limited, "/auth/signin", {
    email: "limited@xlrrank.test",
    password: "wrong",
  });
  expect(rateLimited.status()).toBe(429);
  expect(rateLimited.headers()["retry-after"]).toBeTruthy();

  const deleteResponse = await apiPost(user, "/auth/delete-account", {
    password: FIXTURE_PASSWORD,
  });
  expect(deleteResponse.status()).toBe(204);
  expect((await user.get("/api/auth/me")).status()).toBe(401);
  const deleted = await getUserByEmail("e2e-user@xlrrank.test");
  expect(deleted?.status).toBe("DELETION_PENDING");
  const signinAfterDelete = await apiPost(
    await request.newContext({ baseURL: WEB_URL }),
    "/auth/signin",
    {
      email: "e2e-user@xlrrank.test",
      password: FIXTURE_PASSWORD,
    },
  );
  expect(signinAfterDelete.status()).toBe(401);
});

test("admin dashboard, users, role boundaries, status enforcement, and audit logs use real authorization", async () => {
  const normalUser = await signin("e2e-support@xlrrank.test");
  expect((await normalUser.get("/api/admin/dashboard")).status()).toBe(403);
  expect(
    (
      await apiPut(normalUser, "/admin/users/00000000-0000-0000-0000-000000000000/roles", {
        roles: ["SUPER_ADMIN"],
      })
    ).status(),
  ).toBe(403);

  const admin = await signin("e2e-admin@xlrrank.test");
  const dashboard = await admin.get("/api/admin/dashboard");
  expect(dashboard.status()).toBe(200);
  expect((await dashboard.json()).totalUsers).toBeGreaterThan(0);

  const invalidPage = await admin.get("/api/admin/users?page=garbage&pageSize=20");
  expect(invalidPage.status()).toBe(400);
  const usersResponse = await admin.get(
    "/api/admin/users?page=1&pageSize=10&search=e2e&status=ACTIVE",
  );
  expect(usersResponse.status()).toBe(200);
  const users = (await usersResponse.json()) as { items: Array<{ id: string; email: string }> };
  expect(users.items.length).toBeGreaterThan(0);
  expect(
    (
      await apiPut(admin, `/admin/users/${users.items[0]!.id}/roles`, { roles: ["ADMIN"] })
    ).status(),
  ).toBe(403);

  const superAdmin = await signin("e2e-super@xlrrank.test");
  const target = users.items.find((item) => item.email === "e2e-support@xlrrank.test");
  expect(target).toBeTruthy();
  expect(
    (
      await apiPut(superAdmin, `/admin/users/${target!.id}/roles`, {
        roles: ["USER", "SUPPORT", "SUPPORT"],
      })
    ).status(),
  ).toBe(200);
  const unknownRole = await apiPut(superAdmin, `/admin/users/${target!.id}/roles`, {
    roles: ["NOT_A_ROLE"],
  });
  expect(unknownRole.status()).toBe(400);

  const liveUser = await signin("e2e-support@xlrrank.test");
  expect(
    (await apiPatch(admin, `/admin/users/${target!.id}/status`, { status: "SUSPENDED" })).status(),
  ).toBe(204);
  expect((await liveUser.get("/api/auth/me")).status()).toBe(403);
  expect(
    (await apiPatch(admin, `/admin/users/${target!.id}/status`, { status: "ACTIVE" })).status(),
  ).toBe(204);

  const me = await superAdmin.get("/api/auth/me");
  const meUserId = ((await me.json()) as { user: { userId: string } }).user.userId;
  expect(
    (await apiPut(superAdmin, `/admin/users/${meUserId}/roles`, { roles: ["USER"] })).status(),
  ).toBe(403);

  const auditLogs = await superAdmin.get("/api/admin/audit-logs?limit=50");
  expect(auditLogs.status()).toBe(200);
  const logs = (await auditLogs.json()) as { logs: Array<{ action: string }> };
  expect(logs.logs.some((log) => log.action === "admin.dashboard.view")).toBe(true);
  expect(logs.logs.some((log) => log.action === "admin.user.set_status")).toBe(true);
  expect(logs.logs.some((log) => log.action === "admin.user.set_roles")).toBe(true);
});

test("support tickets enforce ownership, internal-note filtering, and staff workflow", async () => {
  const userA = await signin("e2e-user-a@xlrrank.test");
  const userB = await signin("e2e-user-b@xlrrank.test");
  const support = await signin("e2e-support@xlrrank.test");

  const created = await apiPost(userA, "/support/tickets", {
    subject: "E2E support ticket",
    body: "This is a persisted support ticket body.",
    category: "account",
    priority: "LOW",
  });
  expect(created.status()).toBe(201);
  const ticket = ((await created.json()) as { ticket: { id: string } }).ticket;

  const ownDetail = await userA.get(`/api/support/tickets/${ticket.id}`);
  expect(ownDetail.status()).toBe(200);
  expect((await userB.get(`/api/support/tickets/${ticket.id}`)).status()).toBe(403);
  expect(
    (
      await apiPost(userB, `/support/tickets/${ticket.id}/messages`, {
        body: "Unauthorized message",
      })
    ).status(),
  ).toBe(403);
  expect(
    (await userB.get("/api/support/tickets/00000000-0000-0000-0000-000000000000")).status(),
  ).toBe(404);

  const forgedInternal = await apiPost(userA, `/support/tickets/${ticket.id}/messages`, {
    body: "Attempted hidden message",
    isInternal: true,
  });
  expect(forgedInternal.status()).toBe(403);

  const supportReply = await apiPost(support, `/support/tickets/${ticket.id}/messages`, {
    body: "Public support reply",
  });
  expect(supportReply.status()).toBe(201);
  const internalNote = await apiPost(support, `/support/tickets/${ticket.id}/messages`, {
    body: "Internal staff note",
    isInternal: true,
  });
  expect(internalNote.status()).toBe(201);

  const staffDetail = await support.get(`/api/support/tickets/${ticket.id}`);
  const staffMessages = (
    (await staffDetail.json()) as { messages: Array<{ body: string; isInternal: boolean }> }
  ).messages;
  expect(staffMessages.some((item) => item.body === "Internal staff note" && item.isInternal)).toBe(
    true,
  );

  const userDetail = await userA.get(`/api/support/tickets/${ticket.id}`);
  const userMessages = (
    (await userDetail.json()) as { messages: Array<{ body: string; isInternal: boolean }> }
  ).messages;
  expect(userMessages.some((item) => item.body === "Public support reply")).toBe(true);
  expect(userMessages.some((item) => item.body === "Internal staff note")).toBe(false);

  const update = await apiPatch(support, `/support/tickets/${ticket.id}`, {
    status: "RESOLVED",
    priority: "HIGH",
    assignedToUserId: null,
  });
  expect(update.status()).toBe(200);
  expect(
    (await apiPatch(userA, `/support/tickets/${ticket.id}`, { priority: "URGENT" })).status(),
  ).toBe(403);
});

test("redis-backed rate limiter shares state across limiter instances", async () => {
  const key = `xlrrank:e2e:distributed:${Date.now()}`;
  const store = new RedisRateLimiterStore();
  const first = new FixedWindowRateLimiter({ windowMs: 1_000, limit: 2 }, store);
  const second = new FixedWindowRateLimiter({ windowMs: 1_000, limit: 2 }, store);

  expect((await first.consume(key)).allowed).toBe(true);
  expect((await second.consume(key)).allowed).toBe(true);
  const blocked = await first.consume(key);
  expect(blocked.allowed).toBe(false);
  expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
});
