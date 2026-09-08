import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

async function startXFixture() {
  const requests = [];
  let tokenRequestCount = 0;

  const user = {
    id: "1001",
    username: "xlr_fixture",
    name: "XLR Fixture",
    description: "Synthetic profile",
    location: "Test City",
    url: "https://example.test",
    profile_image_url: "https://example.test/avatar.png",
    created_at: "2024-01-01T00:00:00.000Z",
    verified: true,
    verified_type: "blue",
    public_metrics: {
      followers_count: 12,
      following_count: 3,
      post_count: 4,
      listed_count: 1,
      like_count: 5,
      media_count: 2,
    },
  };

  const pageOne = [
    {
      id: "2001",
      author_id: "1001",
      text: "synthetic page one",
      created_at: "2024-02-01T00:00:00.000Z",
      lang: "en",
      conversation_id: "2001",
      public_metrics: {
        like_count: 7,
        reply_count: 2,
        repost_count: 1,
        quote_count: 1,
        impression_count: 100,
      },
    },
  ];
  const pageTwo = [
    {
      id: "2002",
      author_id: "1001",
      text: "synthetic page two",
      created_at: "2024-02-02T00:00:00.000Z",
      lang: "en",
      conversation_id: "2002",
      public_metrics: {
        like_count: 1,
        reply_count: 0,
        repost_count: 0,
        quote_count: 0,
        impression_count: 20,
      },
    },
  ];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const auth = req.headers.authorization ?? "";
    const authorization = Array.isArray(auth) ? auth.join(",") : auth;
    requests.push({ method: req.method, url: url.pathname + url.search, authorization });

    if (url.pathname === "/2/oauth2/token" && req.method === "POST") {
      tokenRequestCount += 1;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          token_type: "bearer",
          access_token: `fixture-access-${tokenRequestCount}`,
          refresh_token: `fixture-refresh-${tokenRequestCount}`,
          expires_in: 7200,
          scope: "tweet.read users.read follows.read offline.access",
        }),
      );
      return;
    }

    if (!authorization.startsWith("Bearer fixture-access")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ title: "Unauthorized" }] }));
      return;
    }

    res.setHeader("content-type", "application/json");
    res.setHeader("x-rate-limit-limit", "900");
    res.setHeader("x-rate-limit-remaining", "899");
    res.setHeader("x-rate-limit-reset", "1893456000");

    if (url.pathname === "/2/users/by/username/malformed") {
      res.end("{");
      return;
    }
    if (url.pathname === "/2/users/by/username/limited") {
      res.writeHead(429, {
        "content-type": "application/json",
        "x-rate-limit-reset": String(Math.ceil(Date.now() / 1000) + 30),
      });
      res.end(JSON.stringify({ errors: [{ code: 88, message: "Rate limit exceeded" }] }));
      return;
    }
    if (url.pathname === "/2/users/by/username/forbidden") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ title: "Access tier required" }] }));
      return;
    }
    if (url.pathname === "/2/users/by/username/temporary") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ title: "Unavailable" }] }));
      return;
    }

    if (url.pathname === "/2/users/me") {
      res.end(JSON.stringify({ data: user }));
      return;
    }
    if (url.pathname === "/2/users/1001" || url.pathname === "/2/users/by/username/xlr_fixture") {
      res.end(JSON.stringify({ data: user }));
      return;
    }
    if (url.pathname === "/2/users") {
      res.end(JSON.stringify({ data: [user] }));
      return;
    }
    if (url.pathname === "/2/users/1001/tweets") {
      const second = url.searchParams.get("pagination_token") === "timeline-page-2";
      res.end(
        JSON.stringify({
          data: second ? pageTwo : pageOne,
          includes: { users: [user] },
          meta: second ? { result_count: 1 } : { result_count: 1, next_token: "timeline-page-2" },
        }),
      );
      return;
    }
    if (url.pathname === "/2/tweets/search/recent") {
      const query = url.searchParams.get("query") ?? "";
      if (query.includes("conversation_id:2001")) {
        res.end(
          JSON.stringify({
            data: [
              {
                id: "3001",
                author_id: "1002",
                text: "synthetic reply",
                created_at: "2024-02-01T01:00:00.000Z",
                conversation_id: "2001",
                in_reply_to_user_id: "1001",
              },
            ],
            meta: { result_count: 1 },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({ data: pageOne, includes: { users: [user] }, meta: { result_count: 1 } }),
      );
      return;
    }
    if (url.pathname === "/2/users/1001/followers" || url.pathname === "/2/users/1001/following") {
      res.end(JSON.stringify({ data: [user], meta: { result_count: 1 } }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: [{ title: "not found" }] }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    authorizeBaseUrl: `http://127.0.0.1:${address.port}/oauth/authorize`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function context(accessToken, overrides = {}) {
  return {
    scopeId: "scope-x",
    connectionId: "connection-x",
    credentials: {
      accessToken,
      refreshToken: "fixture-refresh",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["tweet.read", "users.read", "follows.read", "offline.access"],
      metadata: { providerUserId: "1001" },
      ...overrides,
    },
  };
}

test("X OAuth adapter builds PKCE URL and exchanges authorization codes", async () => {
  const { XConnector } = await import("../dist/index.js");
  const fixture = await startXFixture();
  try {
    const connector = new XConnector({
      baseUrl: fixture.baseUrl,
      authorizeBaseUrl: fixture.authorizeBaseUrl,
    });
    const oauth = connector.getOAuthAdapter();
    const providerConfig = {
      platformId: "x",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://app.example.test/platforms/x/oauth/callback",
      enabled: true,
    };
    const url = oauth.buildAuthorizationUrl({
      providerConfig,
      state: "state-value",
      codeChallenge: "challenge-value",
      requestedScopes: ["tweet.read", "users.read", "offline.access"],
    });
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("scope"), "tweet.read users.read offline.access");

    const token = await oauth.exchangeAuthorizationCode({
      providerConfig,
      code: "fixture-code",
      codeVerifier: "verifier",
      redirectUri: providerConfig.redirectUri,
    });
    assert.equal(token.accessToken, "fixture-access-1");
    assert.equal(token.refreshToken, "fixture-refresh-1");
    assert.deepEqual(token.grantedScopes, [
      "tweet.read",
      "users.read",
      "follows.read",
      "offline.access",
    ]);
  } finally {
    await fixture.close();
  }
});

test("X connector normalizes identity, posts, replies, follows, metrics, and pagination", async () => {
  const { XConnector } = await import("../dist/index.js");
  const fixture = await startXFixture();
  try {
    const connector = new XConnector({ baseUrl: fixture.baseUrl });
    const ctx = context("fixture-access-1");
    const auth = await connector.authenticate(ctx.credentials, ctx);
    assert.equal(auth.success, true);
    assert.equal(auth.profile.externalId, "1001");
    assert.equal(auth.profile.handle, "xlr_fixture");

    const profile = await connector.getProfile("xlr_fixture", ctx);
    assert.equal(profile.followerCount, 12);
    assert.equal(profile.metadata.publicMetrics.postCount, 4);

    const first = await connector.getContentPage({ accountId: "1001", limit: 5 }, ctx);
    assert.equal(first.items[0].externalId, "2001");
    assert.equal(first.items[0].metrics.likes, 7);
    assert.equal(first.items[0].metrics.comments, 2);
    assert.equal(first.items[0].metrics.shares, 2);
    assert.equal(first.cursor.hasMore, true);
    assert.equal(first.rateLimit.remaining, 899);

    const second = await connector.getContentPage(
      { accountId: "1001", limit: 5, cursor: first.cursor.value },
      ctx,
    );
    assert.equal(second.items[0].externalId, "2002");
    assert.equal(second.cursor.hasMore, false);

    const search = await connector.searchContent("from:xlr_fixture synthetic", 10, ctx);
    assert.equal(search[0].externalId, "2001");

    const replies = await connector.getComments("2001", { limit: 10 }, ctx);
    assert.equal(replies[0].type, "REPLY");
    assert.equal(replies[0].toContentExternalId, "2001");

    const followers = await connector.getFollowers("1001", 10, ctx);
    const following = await connector.getFollowing("1001", 10, ctx);
    assert.equal(followers[0].externalId, "1001");
    assert.equal(following[0].externalId, "1001");

    const metrics = await connector.getMetrics("1001", ctx);
    assert.equal(metrics.followerCount, 12);
    assert.equal(metrics.contentCount, 4);
  } finally {
    await fixture.close();
  }
});

test("X capability gating reflects configuration and granted OAuth scopes", async () => {
  const { evaluateXCapabilities } = await import("../dist/index.js");
  assert.equal(evaluateXCapabilities({ configured: false }).profiles, "CONFIGURATION_REQUIRED");
  const noFollows = evaluateXCapabilities({
    configured: true,
    grantedScopes: ["tweet.read", "users.read"],
  });
  assert.equal(noFollows.profiles, "AVAILABLE");
  assert.equal(noFollows.followers, "PERMISSION_REQUIRED");
});

test("X connector maps provider errors without leaking tokens", async () => {
  const {
    XConnector,
    AuthenticationError,
    CapabilityUnavailableError,
    MalformedProviderResponseError,
    RateLimitError,
    TemporaryProviderError,
  } = await import("../dist/index.js");
  const fixture = await startXFixture();
  try {
    const connector = new XConnector({ baseUrl: fixture.baseUrl });
    const ctx = context("fixture-access-1");
    await assert.rejects(
      () => connector.getProfile("1001", context("bad-token")),
      AuthenticationError,
    );
    await assert.rejects(() => connector.getProfile("limited", ctx), RateLimitError);
    await assert.rejects(() => connector.getProfile("forbidden", ctx), CapabilityUnavailableError);
    await assert.rejects(() => connector.getProfile("temporary", ctx), TemporaryProviderError);
    await assert.rejects(
      () => connector.getProfile("malformed", ctx),
      MalformedProviderResponseError,
    );
    assert.equal(
      fixture.requests.some((request) => request.url.includes("fixture-access")),
      false,
    );
  } finally {
    await fixture.close();
  }
});
