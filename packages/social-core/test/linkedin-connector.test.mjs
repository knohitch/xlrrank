import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import {
  LinkedInConnector,
  evaluateLinkedInCapabilities,
  LINKEDIN_MARKETING_API_VERSION,
  LINKEDIN_RESTLI_PROTOCOL_VERSION,
  verifyLinkedInWebhookChallenge,
  verifyLinkedInWebhookSignature,
  linkedInWebhookDedupeKey,
  encodeLinkedInCursor,
  decodeLinkedInCursor,
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  TemporaryProviderError,
} from "../dist/index.js";

async function startLinkedInFixture() {
  const requests = [];
  let tokenRequestCount = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const versionHeader = req.headers["linkedin-version"];
    const protocolHeader = req.headers["x-restli-protocol-version"];

    requests.push({
      method: req.method,
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      versionHeader,
      protocolHeader,
      token,
    });

    res.setHeader("content-type", "application/json");

    // 1. Token Exchange / Refresh
    if (url.pathname === "/oauth/v2/accessToken" && req.method === "POST") {
      tokenRequestCount += 1;
      res.end(
        JSON.stringify({
          access_token: `linkedin-token-${tokenRequestCount}`,
          expires_in: 5184000,
          token_type: "Bearer",
          refresh_token: `linkedin-refresh-${tokenRequestCount}`,
          scope: "openid profile email r_organization_social rw_organization_admin r_organization_admin r_organization_social_feed",
        }),
      );
      return;
    }

    // Auth validation for remaining endpoints
    if (!token.startsWith("linkedin-token") && !token.startsWith("fixture-token")) {
      if (token === "expired-token") {
        res.writeHead(401);
        res.end(JSON.stringify({ message: "Token expired", status: 401 }));
        return;
      }
      if (token === "role-denied-token") {
        res.writeHead(403);
        res.end(
          JSON.stringify({
            message: "Member not authorized for organization",
            serviceErrorCode: 100,
            status: 403,
          }),
        );
        return;
      }
      if (token === "product-denied-token") {
        res.writeHead(403);
        res.end(
          JSON.stringify({
            message: "Developer Application not approved for Community Management API product",
            status: 403,
          }),
        );
        return;
      }
      if (token === "rate-limited-token") {
        res.writeHead(429, {
          "retry-after": "45",
          "x-li-ratelimit-remaining": "0",
          "x-li-ratelimit-reset": "1789000000",
        });
        res.end(JSON.stringify({ message: "Rate limit exceeded", status: 429 }));
        return;
      }
      if (token === "server-error-token") {
        res.writeHead(500);
        res.end(JSON.stringify({ message: "Internal server error", status: 500 }));
        return;
      }
      res.writeHead(401);
      res.end(JSON.stringify({ message: "Unauthorized", status: 401 }));
      return;
    }

    // 2. OIDC userinfo
    if (url.pathname === "/v2/userinfo") {
      res.end(
        JSON.stringify({
          sub: "member-12345",
          name: "Test Member",
          given_name: "Test",
          family_name: "Member",
          email: "test.member@example.com",
          email_verified: true,
        }),
      );
      return;
    }

    // 3. Organization ACLs
    if (url.pathname === "/organizationAcls") {
      res.end(
        JSON.stringify({
          elements: [
            {
              organization: "urn:li:organization:1001",
              role: "ADMINISTRATOR",
              state: "APPROVED",
              roleAssignee: "urn:li:person:member-12345",
            },
            {
              organization: "urn:li:organization:1002",
              role: "CONTENT_ADMINISTRATOR",
              state: "APPROVED",
              roleAssignee: "urn:li:person:member-12345",
            },
            {
              organization: "urn:li:organization:1003",
              role: "ANALYST",
              state: "APPROVED",
              roleAssignee: "urn:li:person:member-12345",
            },
          ],
        }),
      );
      return;
    }

    if (url.pathname.startsWith("/eventSubscriptions/") && req.method === "PUT") {
      assert.ok(decodeURIComponent(url.pathname).includes("developerApplication:urn:li:developerApplication:999"));
      assert.ok(decodeURIComponent(url.pathname).includes("user:urn:li:person:member-12345"));
      assert.ok(decodeURIComponent(url.pathname).includes("entity:urn:li:organization:1001"));
      res.end(
        JSON.stringify({
          entity: "urn:li:organization:1001",
          eventType: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
          user: "urn:li:person:member-12345",
          expiresAt: "1790000000000",
          webhook: "https://app.example.test/platforms/linkedin/webhook",
        }),
      );
      return;
    }

    // 4. Organization lookup
    if (url.pathname.startsWith("/organizations/")) {
      const orgId = url.pathname.replace("/organizations/", "");
      res.end(
        JSON.stringify({
          id: parseInt(orgId, 10),
          localizedName: `Acme Corp ${orgId}`,
          vanityName: `acme-${orgId}`,
          localizedDescription: `Description for Acme Corp ${orgId}`,
          website: `https://acme-${orgId}.com`,
          primaryOrganizationType: "PUBLIC_COMPANY",
          staffCountRange: "SIZE_51_TO_200",
        }),
      );
      return;
    }

    // 5. Posts API
    if (url.pathname === "/posts") {
      const start = parseInt(url.searchParams.get("start") ?? "0", 10);
      const count = parseInt(url.searchParams.get("count") ?? "10", 10);
      if (start === 0) {
        res.end(
          JSON.stringify({
            elements: [
              {
                id: "urn:li:share:post-page1-1",
                author: "urn:li:organization:1001",
                commentary: "First post on page 1",
                createdAt: 1788900000000,
                lifecycleState: "PUBLISHED",
                visibility: "PUBLIC",
                permalink: "https://www.linkedin.com/feed/update/urn:li:share:post-page1-1",
              },
              {
                id: "urn:li:share:post-page1-2",
                author: "urn:li:organization:1001",
                commentary: "Second post on page 1",
                createdAt: 1788901000000,
                lifecycleState: "PUBLISHED",
                visibility: "PUBLIC",
              },
            ],
            paging: {
              start: 0,
              count: 2,
              total: 3,
            },
          }),
        );
        return;
      }
      if (start === 2) {
        res.end(
          JSON.stringify({
            elements: [
              {
                id: "urn:li:share:post-page2-1",
                author: "urn:li:organization:1001",
                commentary: "Third post on page 2",
                createdAt: 1788902000000,
                lifecycleState: "PUBLISHED",
                visibility: "PUBLIC",
              },
            ],
            paging: {
              start: 2,
              count: 1,
              total: 3,
            },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ elements: [], paging: { start, count, total: 3 } }));
      return;
    }

    // 6. Comments API
    if (url.pathname.includes("/comments")) {
      const start = parseInt(url.searchParams.get("start") ?? "0", 10);
      if (start === 0) {
        res.end(
          JSON.stringify({
            elements: [
              {
                id: "urn:li:comment:(activity:1,comment-1)",
                actor: "urn:li:person:user-1",
                message: { text: "Insightful post!" },
                created: { time: 1788900500000 },
              },
            ],
            paging: { start: 0, count: 1, total: 2 },
          }),
        );
        return;
      }
      if (start === 1) {
        res.end(
          JSON.stringify({
            elements: [
              {
                id: "urn:li:comment:(activity:1,comment-2)",
                actor: "urn:li:person:user-2",
                message: { text: "Second comment!" },
                created: { time: 1788900600000 },
              },
            ],
            paging: { start: 1, count: 1, total: 2 },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ elements: [], paging: { start, count: 1, total: 2 } }));
      return;
    }

    // 7. Network Size (Followers)
    if (url.pathname.startsWith("/networkSizes/")) {
      res.end(JSON.stringify({ firstDegreeSize: 1250 }));
      return;
    }

    // 8. Share Statistics
    if (url.pathname === "/organizationalEntityShareStatistics") {
      res.end(
        JSON.stringify({
          elements: [
            {
              totalShareStatistics: {
                shareCount: 42,
                likeCount: 350,
                commentCount: 88,
                engagement: 0.052,
              },
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ message: "Not found", status: 404 }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("LinkedIn Connector Contract: manifest, version, headers, and truthful capabilities", async (t) => {
  const connector = new LinkedInConnector();
  const manifest = connector.getManifest();

  assert.equal(manifest.id, "linkedin");
  assert.equal(manifest.platformId, "linkedin");
  assert.equal(manifest.apiVersion, LINKEDIN_MARKETING_API_VERSION);
  assert.equal(manifest.apiVersion, "202608");

  // Verify truthful capabilities
  assert.equal(manifest.capabilities.following, "UNAVAILABLE");
  assert.equal(manifest.capabilities.search, "UNAVAILABLE");
  assert.equal(manifest.capabilities.messages, "UNAVAILABLE");
  assert.equal(manifest.capabilities.publishing, "UNAVAILABLE");
  assert.equal(manifest.capabilities.followers, "UNAVAILABLE");
  assert.equal(manifest.capabilities.profiles, "CONFIGURATION_REQUIRED");
  assert.equal(manifest.capabilities.content, "CONFIGURATION_REQUIRED");
  assert.equal(manifest.capabilities.metrics, "CONFIGURATION_REQUIRED");
});

test("LinkedIn Capabilities: dynamic evaluation based on scopes and organization roles", () => {
  // 1. Unconfigured
  const unconfigured = evaluateLinkedInCapabilities({ configured: false });
  assert.equal(unconfigured.profiles, "CONFIGURATION_REQUIRED");

  // 2. Administrator role with all scopes
  const adminEval = evaluateLinkedInCapabilities({
    configured: true,
    grantedScopes: [
      "r_organization_social",
      "rw_organization_admin",
      "r_organization_admin",
      "r_organization_social_feed",
    ],
    access: { organizationRole: "ADMINISTRATOR", communityManagement: true, followerStatistics: true },
  });
  assert.equal(adminEval.profiles, "AVAILABLE");
  assert.equal(adminEval.content, "AVAILABLE");
  assert.equal(adminEval.comments, "AVAILABLE");
  assert.equal(adminEval.metrics, "AVAILABLE");
  assert.equal(adminEval.followers, "UNAVAILABLE");
  assert.equal(adminEval.audience_insights, "AVAILABLE");
  assert.equal(adminEval.following, "UNAVAILABLE");
  assert.equal(adminEval.search, "UNAVAILABLE");

  // 3. Analyst role (metrics allowed, but content/comments denied)
  const analystEval = evaluateLinkedInCapabilities({
    configured: true,
    grantedScopes: [
      "r_organization_social",
      "r_organization_admin",
    ],
    access: { organizationRole: "ANALYST", communityManagement: true, followerStatistics: true },
  });
  assert.equal(analystEval.metrics, "PERMISSION_REQUIRED");
  assert.equal(analystEval.content, "PERMISSION_REQUIRED");
  assert.equal(analystEval.comments, "PERMISSION_REQUIRED");

  const missingProductEval = evaluateLinkedInCapabilities({
    configured: true,
    grantedScopes: ["r_organization_social", "r_organization_admin"],
    access: { organizationRole: "ADMINISTRATOR" },
  });
  assert.equal(missingProductEval.content, "APP_REVIEW_REQUIRED");
  assert.equal(missingProductEval.metrics, "APP_REVIEW_REQUIRED");
});

test("LinkedIn OAuth & Member OIDC Identity", async () => {
  const fixture = await startLinkedInFixture();
  try {
    const connector = new LinkedInConnector({
      baseUrl: fixture.baseUrl,
      authorizeBaseUrl: `${fixture.baseUrl}/oauth/v2/authorization`,
    });
    const adapter = connector.getOAuthAdapter();

    // 1. Build authorization URL
    const authUrl = adapter.buildAuthorizationUrl({
      providerConfig: {
        platformId: "linkedin",
        clientId: "client-abc",
        redirectUri: "https://app.example.com/callback",
        enabled: true,
      },
      state: "state-123",
      codeChallenge: "",
      requestedScopes: ["openid", "profile", "email", "r_organization_social"],
    });

    assert.equal(authUrl.searchParams.get("client_id"), "client-abc");
    assert.equal(authUrl.searchParams.get("state"), "state-123");
    assert.ok(authUrl.searchParams.get("scope")?.includes("openid"));

    // 2. Token code exchange
    const tokenResult = await adapter.exchangeAuthorizationCode({
      providerConfig: {
        platformId: "linkedin",
        clientId: "client-abc",
        clientSecret: "secret-xyz",
        redirectUri: "https://app.example.com/callback",
        enabled: true,
      },
      code: "code-test-1",
      codeVerifier: "",
      redirectUri: "https://app.example.com/callback",
      requestedScopes: ["openid", "profile", "email"],
      contract: {
        authorizationEndpoint: `${fixture.baseUrl}/oauth/v2/authorization`,
        tokenEndpoint: `${fixture.baseUrl}/oauth/v2/accessToken`,
        defaultScopes: [],
        pkceRequired: false,
        supportsRefresh: true,
        supportsRevocation: false,
      },
    });

    assert.ok(tokenResult.accessToken.startsWith("linkedin-token-"));
    assert.ok(tokenResult.refreshToken?.startsWith("linkedin-refresh-"));
    assert.ok(tokenResult.grantedScopes.includes("r_organization_social"));

    // 3. Token refresh
    const refreshResult = await adapter.refreshAccessToken({
      providerConfig: {
        platformId: "linkedin",
        clientId: "client-abc",
        clientSecret: "secret-xyz",
        redirectUri: "https://app.example.com/callback",
        enabled: true,
      },
      refreshToken: tokenResult.refreshToken,
      contract: {
        authorizationEndpoint: `${fixture.baseUrl}/oauth/v2/authorization`,
        tokenEndpoint: `${fixture.baseUrl}/oauth/v2/accessToken`,
        defaultScopes: [],
        pkceRequired: false,
        supportsRefresh: true,
        supportsRevocation: false,
      },
    });
    assert.ok(refreshResult.accessToken.startsWith("linkedin-token-"));

    // 4. Verify Identity via OIDC
    const profile = await adapter.verifyIdentity({ accessToken: tokenResult.accessToken });
    assert.equal(profile.externalId, "member-12345");
    assert.equal(profile.metadata?.providerIdentityType, "LINKEDIN_MEMBER_OIDC");
    assert.equal(profile.metadata?.emailVerified, true);
    assert.equal(profile.followerCount, undefined);
    assert.equal(profile.followingCount, undefined);
    assert.equal(profile.providerDataCategory, "authenticated_member_profile");
  } finally {
    await fixture.close();
  }
});

test("LinkedIn Asset Discovery: discovers administered organizations and Page roles", async () => {
  const fixture = await startLinkedInFixture();
  try {
    const connector = new LinkedInConnector({ baseUrl: fixture.baseUrl });
    const assets = await connector.listAssets({ accessToken: "fixture-token-valid" });

    assert.equal(assets.length, 3);
    assert.equal(assets[0].assetId, "1001");
    assert.equal(assets[0].name, "Acme Corp 1001");
    assert.equal(assets[0].metadata.primaryRole, "ADMINISTRATOR");
    assert.equal(assets[0].metadata.memberUrn, "urn:li:person:member-12345");

    assert.equal(assets[1].assetId, "1002");
    assert.equal(assets[1].metadata.primaryRole, "CONTENT_ADMINISTRATOR");

    assert.equal(assets[2].assetId, "1003");
    assert.equal(assets[2].metadata.primaryRole, "ANALYST");

    // Verify headers sent to LinkedIn
    const req = fixture.requests.find((r) => r.path === "/organizationAcls");
    assert.ok(req);
    assert.equal(req.versionHeader, "202608");
    assert.equal(req.protocolHeader, "2.0.0");
  } finally {
    await fixture.close();
  }
});

test("LinkedIn Ingestion: organization profile, posts pagination, comments pagination, and metrics", async () => {
  const fixture = await startLinkedInFixture();
  try {
    const connector = new LinkedInConnector({ baseUrl: fixture.baseUrl });
    const context = {
      scopeId: "scope-1",
      connectionId: "conn-1",
      credentials: { accessToken: "fixture-token-valid" },
    };

    // 1. Profile
    const profile = await connector.getProfile("1001", context);
    assert.equal(profile?.displayName, "Acme Corp 1001");
    assert.equal(profile?.handle, "acme-1001");
    assert.equal(profile?.website, "https://acme-1001.com");
    assert.equal(profile?.followerCount, undefined);
    assert.equal(profile?.providerDataCategory, "organization_profile");

    // 2. Posts Page 1
    const page1 = await connector.getContentPage({ accountId: "1001", limit: 2 }, context);
    assert.equal(page1.items.length, 2);
    assert.equal(page1.items[0].body, "First post on page 1");
    assert.equal(page1.items[0].providerDataCategory, "organization_social_activity_authenticated_org");
    assert.equal(page1.cursor.hasMore, true);
    assert.ok(page1.cursor.value);

    // Posts Page 2
    const page2 = await connector.getContentPage(
      { accountId: "1001", limit: 2, cursor: page1.cursor.value },
      context,
    );
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0].body, "Third post on page 2");
    assert.equal(page2.cursor.hasMore, false);

    // 3. Comments Page 1 & 2
    const commentPage1 = await connector.getInteractionsPage(
      { accountId: "urn:li:share:post-page1-1", limit: 1 },
      context,
    );
    assert.equal(commentPage1.items.length, 1);
    assert.equal(commentPage1.items[0].body, "Insightful post!");
    assert.equal(commentPage1.items[0].providerDataCategory, "member_social_activity");
    assert.equal(commentPage1.cursor.hasMore, true);

    const commentPage2 = await connector.getInteractionsPage(
      { accountId: "urn:li:share:post-page1-1", limit: 1, cursor: commentPage1.cursor.value },
      context,
    );
    assert.equal(commentPage2.items.length, 1);
    assert.equal(commentPage2.items[0].body, "Second comment!");
    assert.equal(commentPage2.cursor.hasMore, false);

    // 4. Metrics
    const metrics = await connector.getMetrics("1001", context);
    assert.equal(metrics.followerCount, 1250);
    assert.equal(metrics.followingCount, undefined);
    assert.equal(metrics.contentCount, undefined);
    assert.equal(metrics.providerMetrics.linkedInShareStatistics.shareCount, 42);
  } finally {
    await fixture.close();
  }
});

test("LinkedIn Error Classifications: 401, 403 role loss, 403 product review, 429, 500", async () => {
  const fixture = await startLinkedInFixture();
  try {
    const connector = new LinkedInConnector({ baseUrl: fixture.baseUrl });

    // 401 Authentication error -> REAUTH_REQUIRED
    await assert.rejects(
      () =>
        connector.getProfile("1001", {
          scopeId: "s1",
          connectionId: "c1",
          credentials: { accessToken: "expired-token" },
        }),
      (err) => err instanceof AuthenticationError && err.retryClassification === "REAUTH_REQUIRED",
    );

    // 403 Role loss -> NON_RETRYABLE
    await assert.rejects(
      () =>
        connector.getProfile("1001", {
          scopeId: "s1",
          connectionId: "c1",
          credentials: { accessToken: "role-denied-token" },
        }),
      (err) =>
        err instanceof AuthorizationError &&
        err.retryClassification === "NON_RETRYABLE" &&
        err.message.includes("lacks required organization role"),
    );

    // 403 Product review -> NON_RETRYABLE
    await assert.rejects(
      () =>
        connector.getProfile("1001", {
          scopeId: "s1",
          connectionId: "c1",
          credentials: { accessToken: "product-denied-token" },
        }),
      (err) =>
        err instanceof AuthorizationError &&
        err.retryClassification === "NON_RETRYABLE" &&
        err.message.includes("product or permission access required"),
    );

    // 429 Rate limit
    await assert.rejects(
      () =>
        connector.getProfile("1001", {
          scopeId: "s1",
          connectionId: "c1",
          credentials: { accessToken: "rate-limited-token" },
        }),
      (err) => err instanceof RateLimitError && err.retryAfterSeconds === 45,
    );

    // 500 Server error
    await assert.rejects(
      () =>
        connector.getProfile("1001", {
          scopeId: "s1",
          connectionId: "c1",
          credentials: { accessToken: "server-error-token" },
        }),
      (err) => err instanceof TemporaryProviderError,
    );
  } finally {
    await fixture.close();
  }
});

test("LinkedIn Webhook security: official signature vector, mutations, and deduplication", () => {
  const secret = "test-linkedin-secret";

  // 1. Challenge-response verification
  const challenge = "7f240dca-8a19-4822-b941-8628b0305ca7";
  const challengeResult = verifyLinkedInWebhookChallenge(challenge, secret);
  assert.equal(challengeResult.challengeCode, challenge);
  const expectedChallengeHmac = createHmac("sha256", secret).update(challenge, "utf8").digest("hex");
  assert.equal(challengeResult.challengeResponse, expectedChallengeHmac);

  // 2. Signature verification
  const payload = JSON.stringify({
    notificationId: "notif-12345",
    entityUrn: "urn:li:organization:1001",
    action: "ORGANIZATION_SOCIAL_ACTION",
  });
  const validSignature = createHmac("sha256", secret).update(`hmacsha256=${payload}`, "utf8").digest("hex");
  const wrongRawHmac = createHmac("sha256", secret).update(payload, "utf8").digest("hex");

  assert.equal(verifyLinkedInWebhookSignature(payload, validSignature, secret), true);
  assert.equal(verifyLinkedInWebhookSignature(payload, wrongRawHmac, secret), false);
  assert.equal(verifyLinkedInWebhookSignature(payload, `hmacsha256=${validSignature}`, secret), false);
  assert.equal(verifyLinkedInWebhookSignature(payload, `sha256=${validSignature}`, secret), false);
  assert.equal(
    verifyLinkedInWebhookSignature(
      JSON.stringify({ notificationId: "notif-12345", entityUrn: "urn:li:organization:1001", action: "ORGANIZATION_SOCIAL_ACTION" }, null, 2),
      validSignature,
      secret,
    ),
    false,
  );
  assert.equal(
    verifyLinkedInWebhookSignature(
      JSON.stringify({ action: "ORGANIZATION_SOCIAL_ACTION", entityUrn: "urn:li:organization:1001", notificationId: "notif-12345" }),
      validSignature,
      secret,
    ),
    false,
  );
  assert.equal(verifyLinkedInWebhookSignature(payload, "bad-signature", secret), false);
  assert.equal(verifyLinkedInWebhookSignature(payload, undefined, secret), false);

  // 3. Deduplication key
  const dedupeKey = linkedInWebhookDedupeKey({ notificationId: "notif-12345" });
  assert.equal(dedupeKey, "linkedin:notif-12345");
});

test("LinkedIn Event Subscription API: creates Rest.li compound-key subscription and enforces role/scope", async () => {
  const fixture = await startLinkedInFixture();
  try {
    const connector = new LinkedInConnector({ baseUrl: fixture.baseUrl });
    const context = {
      scopeId: "scope-1",
      connectionId: "conn-1",
      credentials: {
        accessToken: "fixture-token-valid",
        scopes: ["rw_organization_admin"],
      },
    };

    const result = await connector.upsertOrganizationSocialActionSubscription(
      {
        developerApplicationUrn: "urn:li:developerApplication:999",
        memberUrn: "urn:li:person:member-12345",
        organizationUrn: "urn:li:organization:1001",
        roles: ["ADMINISTRATOR"],
        webhookUrl: "https://app.example.test/platforms/linkedin/webhook",
      },
      context,
    );
    assert.equal(result.providerStatus, "ACTIVE");
    assert.equal(result.eventType, "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS");
    assert.equal(
      fixture.requests.some((request) => request.method === "PUT" && request.path.startsWith("/eventSubscriptions/")),
      true,
    );

    await assert.rejects(
      () =>
        connector.upsertOrganizationSocialActionSubscription(
          {
            developerApplicationUrn: "urn:li:developerApplication:999",
            memberUrn: "urn:li:person:member-12345",
            organizationUrn: "urn:li:organization:1001",
            roles: ["ANALYST"],
            webhookUrl: "https://app.example.test/platforms/linkedin/webhook",
          },
          context,
        ),
      /ADMINISTRATOR/,
    );
    await assert.rejects(
      () =>
        connector.upsertOrganizationSocialActionSubscription(
          {
            developerApplicationUrn: "urn:li:developerApplication:999",
            memberUrn: "urn:li:person:member-12345",
            organizationUrn: "urn:li:organization:1001",
            roles: ["ADMINISTRATOR"],
            webhookUrl: "https://app.example.test/platforms/linkedin/webhook",
          },
          { ...context, credentials: { accessToken: "fixture-token-valid", scopes: [] } },
        ),
      /rw_organization_admin/,
    );
  } finally {
    await fixture.close();
  }
});
