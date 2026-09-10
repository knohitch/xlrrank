import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

async function startRedditFixture() {
  const requests = [];
  let tokenRequestCount = 0;
  const user = {
    id: "t2_user1",
    name: "xlr_reddit",
    icon_img: "https://example.test/reddit.png",
    link_karma: 42,
    comment_karma: 7,
    created_utc: 1_704_067_200,
    verified: true,
    subreddit: {
      public_description: "Synthetic Reddit profile",
      subscribers: 12,
    },
  };
  const postOne = {
    id: "post1",
    name: "t3_post1",
    author_fullname: "t2_user1",
    author: "xlr_reddit",
    title: "Synthetic post one",
    selftext: "Body one",
    created_utc: 1_704_067_300,
    subreddit: "testing",
    score: 5,
    num_comments: 2,
    permalink: "/r/testing/comments/post1/synthetic/",
  };
  const postTwo = {
    ...postOne,
    id: "post2",
    name: "t3_post2",
    title: "Synthetic post two",
    selftext: "",
  };
  const comment = {
    id: "comment1",
    name: "t1_comment1",
    author_fullname: "t2_commenter",
    author: "commenter",
    body: "Fixture comment",
    created_utc: 1_704_067_400,
    subreddit: "testing",
    score: 3,
    permalink: "/r/testing/comments/post1/synthetic/comment1/",
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authorization = Array.isArray(req.headers.authorization)
      ? req.headers.authorization.join(",")
      : req.headers.authorization ?? "";
    const userAgent = Array.isArray(req.headers["user-agent"])
      ? req.headers["user-agent"].join(",")
      : req.headers["user-agent"] ?? "";
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method,
        url: url.pathname + url.search,
        authorization,
        userAgent,
        body,
      });

      if (url.pathname === "/api/v1/access_token" && req.method === "POST") {
        tokenRequestCount += 1;
        res.setHeader("content-type", "application/json");
        const params = new URLSearchParams(body);
        res.end(
          JSON.stringify({
            token_type: "bearer",
            access_token: `reddit-access-${tokenRequestCount}`,
            refresh_token:
              params.get("grant_type") === "refresh_token" ? undefined : "reddit-refresh-1",
            expires_in: 3600,
            scope: "identity read history",
          }),
        );
        return;
      }

      if (url.pathname === "/api/v1/revoke_token" && req.method === "POST") {
        res.setHeader("content-type", "application/json");
        res.end("{}");
        return;
      }

      if (!authorization.startsWith("Bearer reddit-access")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Unauthorized" }));
        return;
      }
      if (!userAgent.includes("xlrrank-test")) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Missing User-Agent" }));
        return;
      }

      res.setHeader("content-type", "application/json");
      res.setHeader("x-ratelimit-used", "1");
      res.setHeader("x-ratelimit-remaining", "99.5");
      res.setHeader("x-ratelimit-reset", "60");

      if (url.pathname === "/api/v1/me") {
        res.end(JSON.stringify(user));
        return;
      }
      if (url.pathname === "/user/xlr_reddit/about.json" || url.pathname === "/user/user1/about.json") {
        res.end(JSON.stringify({ data: user }));
        return;
      }
      if (url.pathname === "/user/suspended_user/about.json") {
        res.end(JSON.stringify({ data: { ...user, name: "suspended_user", is_suspended: true } }));
        return;
      }
      if (url.pathname === "/user/deleted_user/about.json") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found", error: 404 }));
        return;
      }
      if (url.pathname === "/user/temporary_error/about.json") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "temporary error" }));
        return;
      }
      if (url.pathname === "/user/limited/about.json") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "15" });
        res.end(JSON.stringify({ message: "ratelimited" }));
        return;
      }
      if (url.pathname === "/user/malformed/about.json") {
        res.end("{");
        return;
      }
      if (url.pathname === "/user/temporary/about.json") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "temporary" }));
        return;
      }
      if (url.pathname === "/user/xlr_reddit/submitted.json") {
        const second = url.searchParams.get("after") === "t3_post2";
        res.end(
          JSON.stringify({
            kind: "Listing",
            data: {
              after: second ? null : "t3_post2",
              children: [{ kind: "t3", data: second ? postTwo : postOne }],
            },
          }),
        );
        return;
      }
      if (url.pathname === "/user/xlr_reddit/comments.json") {
        res.end(
          JSON.stringify({
            kind: "Listing",
            data: { after: null, children: [{ kind: "t1", data: comment }] },
          }),
        );
        return;
      }
      if (url.pathname === "/comments/post1.json") {
        res.end(
          JSON.stringify([
            { kind: "Listing", data: { children: [{ kind: "t3", data: postOne }] } },
            { kind: "Listing", data: { children: [{ kind: "t1", data: comment }] } },
          ]),
        );
        return;
      }
      if (url.pathname === "/search.json") {
        res.end(
          JSON.stringify({
            kind: "Listing",
            data: { after: null, children: [{ kind: "t3", data: postOne }] },
          }),
        );
        return;
      }
      if (url.pathname === "/api/info") {
        const ids = (url.searchParams.get("id") ?? "").split(",");
        const children = [];
        if (ids.includes("t3_post1")) {
          children.push({ kind: "t3", data: postOne });
        }
        if (ids.includes("t3_post_removed")) {
          children.push({
            kind: "t3",
            data: { ...postOne, id: "post_removed", name: "t3_post_removed", selftext: "[removed]" },
          });
        }
        if (ids.includes("t1_comment1")) {
          children.push({ kind: "t1", data: comment });
        }
        if (ids.includes("t1_author_deleted")) {
          children.push({
            kind: "t1",
            data: {
              ...comment,
              id: "comment_author_deleted",
              name: "t1_author_deleted",
              author: "[deleted]",
            },
          });
        }
        res.end(JSON.stringify({ kind: "Listing", data: { children } }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    authorizeBaseUrl: `http://127.0.0.1:${address.port}/authorize`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function providerConfig(fixture) {
  return {
    platformId: "reddit",
    clientId: "reddit-client",
    clientSecret: "reddit-secret",
    redirectUri: "https://app.example.test/platforms/reddit/oauth/callback",
    enabled: true,
    metadata: {
      userAgent: "xlrrank-test/1.0 by platform-team",
      access: {
        redditDataApiApproved: true,
        commercialApprovalRequired: true,
        redditCommercialApproved: true,
      },
    },
  };
}

function context(overrides = {}) {
  return {
    scopeId: "scope-reddit",
    connectionId: "connection-reddit",
    credentials: {
      accessToken: "reddit-access-1",
      refreshToken: "reddit-refresh-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["identity", "read", "history"],
      metadata: {
        userAgent: "xlrrank-test/1.0 by platform-team",
        providerUsername: "xlr_reddit",
        access: {
          redditDataApiApproved: true,
          commercialApprovalRequired: true,
          redditCommercialApproved: true,
        },
      },
      ...overrides,
    },
  };
}

test("Reddit OAuth adapter builds official URL, exchanges and refreshes with Basic auth", async () => {
  const { RedditConnector } = await import("../dist/index.js");
  const fixture = await startRedditFixture();
  try {
    const connector = new RedditConnector({
      baseUrl: fixture.baseUrl,
      tokenBaseUrl: fixture.baseUrl,
      authorizeBaseUrl: fixture.authorizeBaseUrl,
    });
    const oauth = connector.getOAuthAdapter();
    const config = providerConfig(fixture);
    const url = oauth.buildAuthorizationUrl({
      providerConfig: config,
      state: "state-value",
      codeChallenge: "unused-pkce-challenge",
      requestedScopes: ["identity", "read", "history"],
    });
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("duration"), "permanent");
    assert.equal(url.searchParams.get("scope"), "identity,read,history");
    assert.equal(url.searchParams.has("code_challenge"), false);

    const exchanged = await oauth.exchangeAuthorizationCode({
      providerConfig: config,
      code: "fixture-code",
      codeVerifier: "unused",
      redirectUri: config.redirectUri,
      requestedScopes: ["identity", "read", "history"],
    });
    assert.equal(exchanged.accessToken, "reddit-access-1");
    assert.equal(exchanged.refreshToken, "reddit-refresh-1");
    assert.deepEqual(exchanged.grantedScopes, ["identity", "read", "history"]);
    assert.equal(exchanged.rawProviderMetadata.userAgent, "xlrrank-test/1.0 by platform-team");
    assert.equal(exchanged.rawProviderMetadata.sourcePolicy.modelTrainingAllowed, false);

    const refreshed = await oauth.refreshAccessToken({
      providerConfig: config,
      refreshToken: "reddit-refresh-1",
    });
    assert.equal(refreshed.accessToken, "reddit-access-2");
    assert.equal(refreshed.refreshToken, undefined);

    await oauth.revoke?.(
      { refreshToken: "reddit-refresh-1" },
      config,
    );
    const tokenPosts = fixture.requests.filter((request) => request.url.startsWith("/api/v1/"));
    assert.equal(tokenPosts.every((request) => request.authorization.startsWith("Basic ")), true);
    assert.equal(tokenPosts.some((request) => request.body.includes("client_secret")), false);
  } finally {
    await fixture.close();
  }
});

test("Reddit connector normalizes profile, submissions, comments, search, pagination, and rate limits", async () => {
  const { RedditConnector } = await import("../dist/index.js");
  const fixture = await startRedditFixture();
  try {
    const connector = new RedditConnector({ baseUrl: fixture.baseUrl, tokenBaseUrl: fixture.baseUrl });
    const ctx = context();
    const auth = await connector.authenticate(ctx.credentials, ctx);
    assert.equal(auth.success, true);
    assert.equal(auth.profile.externalId, "t2_user1");
    assert.equal(auth.profile.providerDataCategory, "reddit_authenticated_user_profile");

    const profile = await connector.getProfile("xlr_reddit", ctx);
    assert.equal(profile.handle, "xlr_reddit");
    assert.equal(profile.providerDataCategory, "reddit_public_user_profile");

    const firstPage = await connector.getContentPage({ limit: 1 }, ctx);
    assert.equal(firstPage.items[0].externalId, "t3_post1");
    assert.equal(firstPage.items[0].providerDataCategory, "reddit_user_content");
    assert.equal(firstPage.cursor.value, "t3_post2");
    assert.equal(firstPage.rateLimit.remaining, 99);

    const secondPage = await connector.getContentPage({ limit: 1000, cursor: firstPage.cursor.value }, ctx);
    assert.equal(secondPage.items[0].externalId, "t3_post2");
    assert.equal(secondPage.cursor.hasMore, false);

    const historyComments = await connector.getInteractionsPage({}, ctx);
    assert.equal(historyComments.items[0].externalId, "t1_comment1");
    assert.equal(historyComments.items[0].providerDataCategory, "reddit_comment");

    const treeComments = await connector.getComments("t3_post1", {}, ctx);
    assert.equal(treeComments.length, 1);
    assert.equal(treeComments[0].toContentExternalId, "t3_post1");

    const search = await connector.searchContent("synthetic", 10, ctx);
    assert.equal(search.length, 1);
    assert.equal(search[0].externalId, "t3_post1");

    assert.equal(
      fixture.requests
        .filter((request) => request.authorization.startsWith("Bearer "))
        .every((request) => request.userAgent === "xlrrank-test/1.0 by platform-team"),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("Reddit capabilities require config, approval, commercial access, and scopes", async () => {
  const { evaluateRedditCapabilities } = await import("../dist/index.js");
  assert.equal(evaluateRedditCapabilities({ configured: false }).profiles, "CONFIGURATION_REQUIRED");
  assert.equal(evaluateRedditCapabilities({ configured: true }).profiles, "APP_REVIEW_REQUIRED");
  assert.equal(
    evaluateRedditCapabilities({
      configured: true,
      access: { redditDataApiApproved: true, commercialApprovalRequired: true },
    }).profiles,
    "ACCESS_REQUIRED",
  );
  assert.equal(
    evaluateRedditCapabilities({
      configured: true,
      grantedScopes: ["identity", "read"],
      access: { redditDataApiApproved: true },
    }).content,
    "PERMISSION_REQUIRED",
  );
  assert.equal(
    evaluateRedditCapabilities({
      configured: true,
      grantedScopes: ["identity", "read", "history"],
      access: { redditDataApiApproved: true },
    }).content,
    "AVAILABLE",
  );
  assert.equal(
    evaluateRedditCapabilities({
      configured: true,
      grantedScopes: ["identity", "read", "history"],
      access: { redditDataApiApproved: true },
    }).followers,
    "UNAVAILABLE",
  );
});

test("Reddit connector maps errors, rejects missing User-Agent, and disallows unsafe production overrides", async () => {
  const { RedditConnector, CapabilityUnavailableError, ConnectorConfigurationError, RateLimitError, TemporaryProviderError } =
    await import("../dist/index.js");
  const fixture = await startRedditFixture();
  try {
    const connector = new RedditConnector({ baseUrl: fixture.baseUrl, tokenBaseUrl: fixture.baseUrl });
    const missingUserAgent = context();
    delete missingUserAgent.credentials.metadata.userAgent;
    await assert.rejects(
      () => connector.getProfile("xlr_reddit", missingUserAgent),
      ConnectorConfigurationError,
    );
    await assert.rejects(() => connector.getProfile("limited", context()), RateLimitError);
    await assert.rejects(() => connector.getProfile("temporary", context()), TemporaryProviderError);
    await assert.rejects(() => connector.getProfile("malformed", context()), /valid JSON/);
    await assert.rejects(() => connector.getFollowers("xlr_reddit", 10, context()), CapabilityUnavailableError);
    await assert.rejects(() => connector.getFollowing("xlr_reddit", 10, context()), CapabilityUnavailableError);

    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    assert.throws(
      () => new RedditConnector({ baseUrl: fixture.baseUrl }),
      ConnectorConfigurationError,
    );
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  } finally {
    await fixture.close();
  }
});

test("Reddit connector reconcileResources queries /api/info for Links/Comments and /user/about for Accounts", async () => {
  const { RedditConnector } = await import("../dist/index.js");
  const fixture = await startRedditFixture();
  try {
    const connector = new RedditConnector({ baseUrl: fixture.baseUrl, tokenBaseUrl: fixture.baseUrl });
    const ctx = context();
    const result = await connector.reconcileResources(
      [
        { id: "1", externalId: "t3_post1", entityType: "CONTENT" },
        { id: "2", externalId: "t3_post_removed", entityType: "CONTENT" },
        { id: "3", externalId: "t3_completely_missing", entityType: "CONTENT" },
        { id: "4", externalId: "t1_comment1", entityType: "INTERACTION" },
        { id: "5", externalId: "t1_author_deleted", entityType: "INTERACTION" },
        { id: "6", externalId: "t2_user1", entityType: "ACCOUNT", lookupKey: "user1" },
        { id: "7", externalId: "t2_suspended", entityType: "ACCOUNT", lookupKey: "suspended_user" },
        { id: "8", externalId: "t2_deleted", entityType: "ACCOUNT", lookupKey: "deleted_user" },
        { id: "9", externalId: "t2_temporary", entityType: "ACCOUNT", lookupKey: "temporary_error" },
        { id: "10", externalId: "t2_no_handle", entityType: "ACCOUNT" },
      ],
      ctx,
    );

    const statuses = new Map(result.statuses.map((s) => [s.externalId, s]));

    // Content: /api/info
    assert.equal(statuses.get("t3_post1")?.state, "EXISTS");
    assert.equal(statuses.get("t3_post1")?.authorDeleted, false);
    assert.equal(statuses.get("t3_post_removed")?.state, "DELETED");
    assert.equal(statuses.get("t3_completely_missing")?.state, "DELETED");

    // Interactions: /api/info
    assert.equal(statuses.get("t1_comment1")?.state, "EXISTS");
    assert.equal(statuses.get("t1_author_deleted")?.state, "EXISTS");
    assert.equal(statuses.get("t1_author_deleted")?.authorDeleted, true);

    // Accounts: /user/{username}/about.json
    assert.equal(statuses.get("t2_user1")?.state, "EXISTS");
    assert.equal(statuses.get("t2_suspended")?.state, "UNKNOWN");
    assert.equal(statuses.get("t2_suspended")?.details?.reason, "ACCOUNT_SUSPENDED");
    assert.equal(statuses.get("t2_deleted")?.state, "UNKNOWN");
    assert.equal(statuses.get("t2_deleted")?.details?.reason, "ACCOUNT_NOT_FOUND_404");
    assert.equal(statuses.get("t2_temporary")?.state, "UNKNOWN");
    assert.equal(statuses.get("t2_no_handle")?.state, "UNKNOWN");
  } finally {
    await fixture.close();
  }
});
