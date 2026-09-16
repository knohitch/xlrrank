import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";

async function startMetaFixture() {
  const requests = [];
  let tokenRequestCount = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, params: Object.fromEntries(url.searchParams) });
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/v26.0/oauth/access_token" && req.method === "POST") {
      tokenRequestCount += 1;
      res.end(JSON.stringify({
        access_token: `meta-access-${tokenRequestCount}`,
        token_type: "bearer",
        expires_in: 5184000,
        scope: "public_profile,pages_show_list,pages_read_engagement,pages_read_user_content,read_insights,instagram_basic,instagram_manage_insights,instagram_manage_comments",
      }));
      return;
    }

    if (!url.searchParams.get("access_token")?.startsWith("meta-access")) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { type: "OAuthException", code: 190, message: "bad token" } }));
      return;
    }

    res.setHeader("x-app-usage", JSON.stringify({ call_count: 1 }));
    if (url.pathname === "/v26.0/me") {
      res.end(JSON.stringify({ id: "meta-user-1", name: "Meta User" }));
      return;
    }
    if (url.pathname === "/v26.0/me/accounts") {
      res.end(JSON.stringify({
        data: [{
          id: "page-1",
          name: "Fixture Page",
          username: "fixture_page",
          category: "Community",
          access_token: "meta-access-page-1",
          tasks: ["ANALYZE"],
          instagram_business_account: { id: "ig-1", username: "fixture_ig", name: "Fixture IG", account_type: "BUSINESS" },
        }, {
          id: "page-2",
          name: "Fixture Page 2",
          username: "fixture_page_2",
          category: "Community",
          access_token: "meta-access-page-2",
          tasks: ["ANALYZE"],
        }],
      }));
      return;
    }
    if (url.pathname === "/v26.0/page-1") {
      res.end(JSON.stringify({
        id: "page-1",
        name: "Fixture Page",
        username: "fixture_page",
        about: "Synthetic page",
        website: "https://example.test",
        fan_count: 12,
        followers_count: 14,
        picture: { data: { url: "https://example.test/page.png" } },
      }));
      return;
    }
    if (url.pathname === "/v26.0/page-1/posts") {
      res.end(JSON.stringify({
        data: [{
          id: "post-1",
          message: "facebook fixture post",
          created_time: "2026-01-01T00:00:00+0000",
          permalink_url: "https://facebook.com/post-1",
          shares: { count: 2 },
          comments: { summary: { total_count: 3 } },
          reactions: { summary: { total_count: 5 } },
        }],
        paging: { cursors: { after: "fb-after-1" } },
      }));
      return;
    }
    if (url.pathname === "/v26.0/post-1/comments") {
      const second = url.searchParams.get("after") === "fb-comments-2";
      res.end(JSON.stringify({
        data: [{ id: second ? "comment-2" : "comment-1", message: "fb comment", created_time: "2026-01-01T01:00:00+0000", from: { id: "user-2" } }],
        paging: second ? undefined : { cursors: { after: "fb-comments-2" } },
      }));
      return;
    }
    if (url.pathname === "/v26.0/ig-1") {
      res.end(JSON.stringify({
        id: "ig-1",
        username: "fixture_ig",
        name: "Fixture IG",
        biography: "Synthetic IG",
        website: "https://example.test/ig",
        profile_picture_url: "https://example.test/ig.png",
        followers_count: 22,
        follows_count: 7,
        media_count: 4,
        account_type: "BUSINESS",
      }));
      return;
    }
    if (url.pathname === "/v26.0/ig-1/media") {
      res.end(JSON.stringify({
        data: [{ id: "media-1", caption: "instagram fixture media", media_type: "IMAGE", media_product_type: "FEED", timestamp: "2026-01-02T00:00:00+0000", permalink: "https://instagram.com/p/media-1", like_count: 9, comments_count: 2 }],
        paging: { cursors: { after: "ig-after-1" } },
      }));
      return;
    }
    if (url.pathname === "/v26.0/media-1/comments") {
      const second = url.searchParams.get("after") === "ig-comments-2";
      res.end(JSON.stringify({
        data: [{ id: second ? "ig-comment-2" : "ig-comment-1", text: "ig comment", timestamp: "2026-01-02T01:00:00+0000", username: "commenter" }],
        paging: second ? undefined : { cursors: { after: "ig-comments-2" } },
      }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    authorizeBaseUrl: `http://127.0.0.1:${address.port}/v26.0/dialog/oauth`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startInstagramLoginFixture() {
  const requests = { auth: [], token: [], graph: [], facebookTrap: [] };
  const authServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.auth.push({ method: req.method, path: url.pathname, params: Object.fromEntries(url.searchParams) });
    res.writeHead(404);
    res.end();
  });
  const tokenServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await readBody(req);
    requests.token.push({ method: req.method, path: url.pathname, body: Object.fromEntries(new URLSearchParams(body)) });
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/oauth/access_token" && req.method === "POST") {
      res.end(JSON.stringify({ access_token: "ig-short-token", user_id: "ig-direct-1" }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  const graphServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.graph.push({ method: req.method, path: url.pathname, params: Object.fromEntries(url.searchParams) });
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/access_token") {
      assert.equal(url.searchParams.get("grant_type"), "ig_exchange_token");
      assert.equal(url.searchParams.get("access_token"), "ig-short-token");
      res.end(JSON.stringify({ access_token: "ig-long-token", token_type: "bearer", expires_in: 5184000 }));
      return;
    }
    if (url.pathname === "/refresh_access_token") {
      assert.equal(url.searchParams.get("grant_type"), "ig_refresh_token");
      assert.equal(url.searchParams.get("access_token"), "ig-long-token");
      res.end(JSON.stringify({ access_token: "ig-refreshed-token", token_type: "bearer", expires_in: 5184000 }));
      return;
    }
    if (url.searchParams.get("access_token") !== "ig-long-token") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { type: "OAuthException", code: 190, message: "bad token" } }));
      return;
    }
    if (url.pathname === "/v26.0/me" || url.pathname === "/v26.0/ig-direct-1") {
      res.end(JSON.stringify({
        user_id: "ig-direct-1",
        username: "direct_ig",
        name: "Direct IG",
        followers_count: 42,
        follows_count: 8,
        media_count: 2,
        account_type: "BUSINESS",
      }));
      return;
    }
    if (url.pathname === "/v26.0/ig-direct-1/media") {
      const second = url.searchParams.get("after") === "direct-media-2";
      res.end(JSON.stringify({
        data: [{ id: second ? "direct-media-2" : "direct-media-1", caption: "direct media", media_type: "IMAGE", timestamp: "2026-02-01T00:00:00+0000", like_count: 4, comments_count: 1 }],
        paging: second ? undefined : { cursors: { after: "direct-media-2" } },
      }));
      return;
    }
    if (url.pathname === "/v26.0/direct-media-1/comments") {
      const second = url.searchParams.get("after") === "direct-comment-2";
      res.end(JSON.stringify({
        data: [{ id: second ? "direct-comment-2" : "direct-comment-1", text: "direct comment", timestamp: "2026-02-01T01:00:00+0000", username: "commenter" }],
        paging: second ? undefined : { cursors: { after: "direct-comment-2" } },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: `not found: ${url.pathname}` } }));
  });
  const facebookTrap = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.facebookTrap.push({ method: req.method, path: url.pathname });
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "facebook graph trap" } }));
  });
  await Promise.all([authServer, tokenServer, graphServer, facebookTrap].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const urlFor = (server) => {
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
  };
  return {
    authorizeBaseUrl: `${urlFor(authServer)}/oauth/authorize`,
    tokenEndpoint: `${urlFor(tokenServer)}/oauth/access_token`,
    graphBaseUrl: urlFor(graphServer),
    longTokenEndpoint: `${urlFor(graphServer)}/access_token`,
    refreshEndpoint: `${urlFor(graphServer)}/refresh_access_token`,
    facebookTrapBaseUrl: urlFor(facebookTrap),
    requests,
    close: async () => {
      await Promise.all([authServer, tokenServer, graphServer, facebookTrap].map((server) => new Promise((resolve) => server.close(resolve))));
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function ctx(platform, assetId) {
  return {
    scopeId: `scope-${platform}`,
    connectionId: `connection-${platform}`,
    credentials: {
      accessToken: "meta-access-1",
      scopes: ["public_profile", "pages_show_list", "pages_read_engagement", "pages_read_user_content", "read_insights", "instagram_basic", "instagram_manage_insights", "instagram_manage_comments"],
      metadata: { assetId, appSecret: "app-secret" },
    },
  };
}

function directInstagramCtx(assetId = "ig-direct-1", accessToken = "ig-long-token") {
  return {
    scopeId: "scope-instagram-direct",
    connectionId: "connection-instagram-direct",
    credentials: {
      accessToken,
      refreshToken: accessToken,
      scopes: ["instagram_business_basic", "instagram_business_manage_comments"],
      metadata: { assetId, authMode: "INSTAGRAM_LOGIN" },
    },
  };
}

test("Meta helpers produce Graph v26 appsecret proof", async () => {
  const { META_GRAPH_API_VERSION, appSecretProof } = await import("../dist/index.js");
  assert.equal(META_GRAPH_API_VERSION, "v26.0");
  assert.equal(appSecretProof("token", "secret"), createHmac("sha256", "secret").update("token").digest("hex"));
});

test("Facebook Pages connector handles OAuth, assets, pagination, and normalization", async () => {
  const { FacebookConnector, evaluateFacebookCapabilities } = await import("../dist/index.js");
  const fixture = await startMetaFixture();
  try {
    const connector = new FacebookConnector({ baseUrl: fixture.baseUrl, authorizeBaseUrl: fixture.authorizeBaseUrl });
    const oauth = connector.getOAuthAdapter();
    const providerConfig = { platformId: "facebook", clientId: "app-id", clientSecret: "app-secret", redirectUri: "https://app.example.test/callback", enabled: true };
    const url = oauth.buildAuthorizationUrl({ providerConfig, state: "state", codeChallenge: "unused", requestedScopes: ["pages_show_list", "pages_read_engagement"] });
    assert.equal(url.pathname, "/v26.0/dialog/oauth");
    assert.equal(url.searchParams.get("scope"), "pages_show_list,pages_read_engagement");

    const token = await oauth.exchangeAuthorizationCode({
      providerConfig,
      code: "code",
      codeVerifier: "unused",
      redirectUri: providerConfig.redirectUri,
      requestedScopes: ["pages_show_list", "pages_read_engagement"],
    });
    assert.equal(token.accessToken, "meta-access-1");
    assert.ok(token.grantedScopes.includes("read_insights"));
    const assets = await connector.listAssets(ctx("facebook", "page-1").credentials);
    assert.deepEqual(assets.map((asset) => asset.assetId), ["page-1", "ig-1", "page-2"]);

    const profile = await connector.getAuthenticatedProfile(ctx("facebook", "page-1"));
    assert.equal(profile.handle, "fixture_page");
    assert.equal(profile.followerCount, 14);
    const page = await connector.getContentPage({ limit: 5 }, ctx("facebook", "page-1"));
    assert.equal(page.items[0].externalId, "post-1");
    assert.equal(page.items[0].metrics.shares, 2);
    assert.equal(page.cursor.hasMore, true);
    assert.equal(page.rateLimit.providerMetadata.headers.hasAppUsage, true);
    const comments = await connector.getInteractionsPage({ accountId: "post-1" }, ctx("facebook", "page-1"));
    assert.equal(comments.items[0].type, "COMMENT");
    assert.equal(comments.cursor.hasMore, true);
    const comments2 = await connector.getInteractionsPage({ accountId: "post-1", cursor: comments.cursor.value }, ctx("facebook", "page-1"));
    assert.equal(comments2.items[0].externalId, "comment-2");
    const metrics = await connector.getMetrics("page-1", ctx("facebook", "page-1"));
    assert.equal(metrics.contentCount, 0);
    assert.equal(evaluateFacebookCapabilities({ configured: true, grantedScopes: ["pages_show_list"] }).content, "PERMISSION_REQUIRED");
    assert.ok(fixture.requests.some((request) => request.params.appsecret_proof));
  } finally {
    await fixture.close();
  }
});

test("Instagram connector handles Page-linked professional assets and read-only ingestion", async () => {
  const { InstagramConnector, evaluateInstagramCapabilities } = await import("../dist/index.js");
  const fixture = await startMetaFixture();
  try {
    const connector = new InstagramConnector({ baseUrl: fixture.baseUrl, authorizeBaseUrl: fixture.authorizeBaseUrl });
    assert.deepEqual(
      connector.getManifest().oauth.authModes.map((mode) => mode.id),
      ["FACEBOOK_LOGIN", "INSTAGRAM_LOGIN"],
    );
    const assets = await connector.listAssets(ctx("instagram", "ig-1").credentials);
    assert.equal(assets[0].assetId, "ig-1");
    assert.equal(assets[0].parentAssetId, "page-1");

    const profile = await connector.getAuthenticatedProfile(ctx("instagram", "ig-1"));
    assert.equal(profile.handle, "fixture_ig");
    assert.equal(profile.metadata.accountType, "BUSINESS");
    const page = await connector.getContentPage({ limit: 5 }, ctx("instagram", "ig-1"));
    assert.equal(page.items[0].externalId, "media-1");
    assert.equal(page.items[0].metrics.likes, 9);
    const comments = await connector.getInteractionsPage({ accountId: "media-1" }, ctx("instagram", "ig-1"));
    assert.equal(comments.items[0].fromExternalId, "commenter");
    assert.equal(comments.cursor.hasMore, true);
    const comments2 = await connector.getInteractionsPage({ accountId: "media-1", cursor: comments.cursor.value }, ctx("instagram", "ig-1"));
    assert.equal(comments2.items[0].externalId, "ig-comment-2");
    assert.equal(evaluateInstagramCapabilities({ configured: true, grantedScopes: ["instagram_basic"] }).comments, "PERMISSION_REQUIRED");
    assert.equal(evaluateInstagramCapabilities({ configured: true, grantedScopes: ["instagram_basic"] }).metrics, "AVAILABLE");
    assert.equal(connector.getManifest().capabilities.publishing, "UNAVAILABLE");
  } finally {
    await fixture.close();
  }
});

test("Instagram connector executes direct Instagram Login against Instagram Graph only", async () => {
  const { InstagramConnector, evaluateInstagramCapabilities } = await import("../dist/index.js");
  const fixture = await startInstagramLoginFixture();
  try {
    const connector = new InstagramConnector({
      baseUrl: fixture.facebookTrapBaseUrl,
      instagramLoginGraphBaseUrl: fixture.graphBaseUrl,
      instagramLoginAuthorizeBaseUrl: fixture.authorizeBaseUrl,
      instagramLoginTokenEndpoint: fixture.tokenEndpoint,
      instagramLoginLongTokenEndpoint: fixture.longTokenEndpoint,
      instagramLoginRefreshEndpoint: fixture.refreshEndpoint,
    });
    const providerConfig = {
      platformId: "instagram",
      clientId: "ig-app-id",
      clientSecret: "ig-app-secret",
      redirectUri: "https://app.example.test/instagram/callback",
      enabled: true,
      metadata: { authMode: "INSTAGRAM_LOGIN" },
    };
    const contract = {
      id: "INSTAGRAM_LOGIN",
      authorizationEndpoint: fixture.authorizeBaseUrl,
      tokenEndpoint: fixture.tokenEndpoint,
      defaultScopes: ["instagram_business_basic", "instagram_business_manage_comments"],
      pkceRequired: false,
      supportsRefresh: true,
      supportsRevocation: false,
      apiBaseUrl: fixture.graphBaseUrl,
    };
    const oauth = connector.getOAuthAdapter();
    const authUrl = oauth.buildAuthorizationUrl({
      providerConfig,
      contract,
      state: "state",
      codeChallenge: "unused",
      requestedScopes: contract.defaultScopes,
    });
    assert.equal(authUrl.pathname, "/oauth/authorize");
    assert.equal(authUrl.searchParams.get("scope"), "instagram_business_basic,instagram_business_manage_comments");
    assert.equal(authUrl.searchParams.get("scope").includes("instagram_basic"), false);
    assert.equal(authUrl.searchParams.get("scope").includes("pages_show_list"), false);

    const exchanged = await oauth.exchangeAuthorizationCode({
      providerConfig,
      contract,
      code: "ig-code",
      codeVerifier: "unused",
      redirectUri: providerConfig.redirectUri,
      requestedScopes: contract.defaultScopes,
    });
    assert.equal(exchanged.accessToken, "ig-long-token");
    assert.equal(exchanged.refreshToken, "ig-long-token");
    assert.deepEqual(exchanged.grantedScopes, [
      "instagram_business_basic",
      "instagram_business_manage_comments",
    ]);

    const credentials = {
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      scopes: exchanged.grantedScopes,
      metadata: { authMode: "INSTAGRAM_LOGIN" },
    };
    const identity = await oauth.verifyIdentity(credentials, { ...directInstagramCtx(), credentials });
    assert.equal(identity.externalId, "ig-direct-1");
    const assets = await connector.listAssets({ ...credentials, metadata: { ...credentials.metadata, providerUserId: identity.externalId } });
    assert.equal(assets.length, 1);
    assert.equal(assets[0].assetId, "ig-direct-1");
    assert.equal(assets[0].tokenKind, "USER");
    assert.equal(assets[0].parentAssetId, undefined);

    const selectedCredentials = { ...credentials, metadata: { ...credentials.metadata, assetId: "ig-direct-1" } };
    const profile = await connector.getAuthenticatedProfile({ ...directInstagramCtx(), credentials: selectedCredentials });
    assert.equal(profile.handle, "direct_ig");
    const media = await connector.getContentPage({ limit: 5 }, { ...directInstagramCtx(), credentials: selectedCredentials });
    assert.equal(media.items[0].externalId, "direct-media-1");
    assert.equal(media.cursor.hasMore, true);
    const comments = await connector.getInteractionsPage({ accountId: "direct-media-1" }, { ...directInstagramCtx(), credentials: selectedCredentials });
    assert.equal(comments.items[0].externalId, "direct-comment-1");
    assert.equal(comments.cursor.hasMore, true);
    const comments2 = await connector.getInteractionsPage({ accountId: "direct-media-1", cursor: comments.cursor.value }, { ...directInstagramCtx(), credentials: selectedCredentials });
    assert.equal(comments2.items[0].externalId, "direct-comment-2");
    const refreshed = await oauth.refreshAccessToken({ providerConfig, contract, refreshToken: "ig-long-token" });
    assert.equal(refreshed.accessToken, "ig-refreshed-token");

    assert.equal(fixture.requests.facebookTrap.length, 0);
    assert.equal(fixture.requests.graph.some((request) => request.path === "/v26.0/me"), true);
    assert.equal(fixture.requests.graph.some((request) => request.path === "/v26.0/me/accounts"), false);
    assert.equal(fixture.requests.graph.some((request) => request.path === "/v26.0/ig-direct-1/media"), true);
    assert.equal(fixture.requests.graph.some((request) => request.path === "/v26.0/direct-media-1/comments"), true);
    assert.equal(fixture.requests.token[0].method, "POST");
    assert.equal(fixture.requests.token[0].body.grant_type, "authorization_code");
    assert.equal(fixture.requests.graph.some((request) => request.path === "/access_token"), true);
    assert.equal(fixture.requests.graph.some((request) => request.path === "/refresh_access_token"), true);
    assert.equal(evaluateInstagramCapabilities({
      configured: true,
      authMode: "INSTAGRAM_LOGIN",
      grantedScopes: ["instagram_business_basic"],
    }).content, "AVAILABLE");
    assert.equal(evaluateInstagramCapabilities({
      configured: true,
      authMode: "INSTAGRAM_LOGIN",
      grantedScopes: ["instagram_basic", "instagram_manage_comments"],
    }).content, "PERMISSION_REQUIRED");
  } finally {
    await fixture.close();
  }
});
