import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

async function startFixture() {
  const requests = [];
  const data = {
    "token-a": {
      profile: { id: "acct-a", handle: "alpha", visibility: "PUBLIC" },
      content: [
        [
          {
            id: "post-1",
            authorId: "acct-a",
            body: "page one",
            visibility: "PUBLIC",
            metrics: { likes: 1, snapshotKey: "post-1:p1" },
          },
        ],
        [
          {
            id: "post-2",
            authorId: "acct-a",
            body: "page two",
            visibility: "PUBLIC",
            metrics: { likes: 2, snapshotKey: "post-2:p2" },
          },
        ],
      ],
    },
    "token-b": {
      profile: { id: "acct-b", handle: "beta", visibility: "SCOPE_PRIVATE" },
      content: [
        [{ id: "post-private", authorId: "acct-b", body: "private", visibility: "SCOPE_PRIVATE" }],
        [],
      ],
    },
  };

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const token = Array.isArray(auth) ? "" : auth.replace("Bearer ", "");
    requests.push({ token, url: req.url });
    if (req.url?.includes("temporary-failure")) {
      res.writeHead(503).end(JSON.stringify({ error: "temporary" }));
      return;
    }
    if (req.url?.includes("permanent-failure")) {
      res.writeHead(400).end(JSON.stringify({ error: "permanent" }));
      return;
    }
    if (req.url?.includes("malformed")) {
      res.writeHead(200).end("{");
      return;
    }
    if (req.url?.includes("rate-limit")) {
      res.writeHead(429, { "retry-after": "9" }).end(JSON.stringify({ error: "limited" }));
      return;
    }
    const tenant = data[token];
    if (!tenant) {
      res.writeHead(401).end(JSON.stringify({ error: "bad token" }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.setHeader("x-fixture-rate-remaining", "42");
    res.setHeader("x-fixture-rate-reset-at", "2030-01-01T00:00:00.000Z");
    if (req.url?.startsWith("/auth/me")) {
      res.end(JSON.stringify(tenant.profile));
      return;
    }
    if (req.url?.startsWith("/content")) {
      const url = new URL(req.url, "http://127.0.0.1");
      const cursor = url.searchParams.get("cursor");
      const index = cursor === "page-2" ? 1 : 0;
      res.end(
        JSON.stringify({
          items: tenant.content[index],
          nextCursor: index === 0 ? "page-2" : null,
          hasMore: index === 0,
        }),
      );
      return;
    }
    if (req.url?.startsWith("/interactions")) {
      res.end(
        JSON.stringify({
          items: [
            {
              id: `int-${tenant.profile.id}`,
              fromId: tenant.profile.id,
              type: "LIKE",
              visibility: tenant.profile.visibility,
              occurredAt: "2030-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
          hasMore: false,
        }),
      );
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function credentials(baseUrl, token) {
  return { accessToken: token, metadata: { fixtureBaseUrl: baseUrl } };
}

test("reference connector uses isolated operation credentials concurrently", async () => {
  const { ReferenceHttpConnector } = await import("../dist/index.js");
  const fixture = await startFixture();
  try {
    const a = new ReferenceHttpConnector();
    const b = new ReferenceHttpConnector();
    const [profileA, profileB] = await Promise.all([
      a.authenticate(credentials(fixture.baseUrl, "token-a"), {
        scopeId: "scope-a",
        connectionId: "connection-a",
        credentials: credentials(fixture.baseUrl, "token-a"),
      }),
      b.authenticate(credentials(fixture.baseUrl, "token-b"), {
        scopeId: "scope-b",
        connectionId: "connection-b",
        credentials: credentials(fixture.baseUrl, "token-b"),
      }),
    ]);
    assert.equal(profileA.profile?.externalId, "acct-a");
    assert.equal(profileB.profile?.externalId, "acct-b");
    assert.equal(a.getStatus(), "DISCONNECTED");
    assert.equal(b.getStatus(), "DISCONNECTED");
    assert.ok(fixture.requests.some((r) => r.token === "token-a"));
    assert.ok(fixture.requests.some((r) => r.token === "token-b"));
  } finally {
    await fixture.close();
  }
});

test("registry creates isolated operation instances and rejects production reference registration", async () => {
  const { ConnectorRegistry, ReferenceHttpConnector } = await import("../dist/index.js");
  const registry = new ConnectorRegistry();
  registry.registerFactory(() => new ReferenceHttpConnector(), { testOnly: true });
  const first = registry.create("reference-http");
  const second = registry.create("reference-http");
  assert.notEqual(first, second);
  assert.equal(registry.list()[0].manifest.capabilities.following, "UNAVAILABLE");

  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  assert.throws(() => new ReferenceHttpConnector(), /test-only/);
  if (original === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original;
});

test("reference connector enforces capabilities, rate limits, malformed payloads, and retry classes", async () => {
  const {
    CapabilityUnavailableError,
    MalformedProviderResponseError,
    PermanentProviderError,
    RateLimitError,
    ReferenceHttpConnector,
    TemporaryProviderError,
  } = await import("../dist/index.js");
  const fixture = await startFixture();
  const connector = new ReferenceHttpConnector();
  const ctx = {
    scopeId: "scope-a",
    connectionId: "connection-a",
    credentials: credentials(fixture.baseUrl, "token-a"),
  };
  try {
    const page = await connector.getContentPage({ limit: 1 }, ctx);
    assert.equal(page.items.length, 1);
    assert.equal(page.cursor.value, "page-2");
    assert.equal(page.cursor.hasMore, true);
    assert.equal(page.rateLimit?.remaining, 42);

    await assert.rejects(
      () => connector.getFollowers("acct-a", 1, ctx),
      CapabilityUnavailableError,
    );
    await assert.rejects(
      () => connector.getFollowing("acct-a", 1, ctx),
      CapabilityUnavailableError,
    );
    await assert.rejects(
      () => connector.getContentPage({ cursor: "rate-limit" }, ctx),
      (err) => err instanceof RateLimitError && err.retryClassification === "RETRYABLE",
    );
    await assert.rejects(
      () => connector.getContentPage({ cursor: "temporary-failure" }, ctx),
      (err) => err instanceof TemporaryProviderError && err.retryClassification === "RETRYABLE",
    );
    await assert.rejects(
      () => connector.getContentPage({ cursor: "permanent-failure" }, ctx),
      (err) => err instanceof PermanentProviderError && err.retryClassification === "NON_RETRYABLE",
    );
    await assert.rejects(
      () => connector.getContentPage({ cursor: "malformed" }, ctx),
      MalformedProviderResponseError,
    );
  } finally {
    await fixture.close();
  }
});
