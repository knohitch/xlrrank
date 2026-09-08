# X Connector OAuth and API State

Sprint 06 uses the current official X Developer Platform documentation crawled on 2026-09-08.

## Official Sources Consulted

- X documentation index: `https://docs.x.com/llms.txt`
- X API v2 index: `https://docs.x.com/x-api/llms.txt`
- OAuth 2.0 Authorization Code with PKCE: `https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code`
- X API v2 authentication mapping: `https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping`
- Rate limits: `https://docs.x.com/x-api/fundamentals/rate-limits`
- OpenAPI reference location: `https://docs.x.com/x-api/general/get-openapi-spec`
- OpenAPI JSON endpoint: `https://api.x.com/2/openapi.json`
- User lookup/authenticated user: `GET https://api.x.com/2/users/me`
- User timeline: `GET https://api.x.com/2/users/:id/tweets`
- Recent search: `GET https://api.x.com/2/tweets/search/recent`
- Followers/following: `GET https://api.x.com/2/users/:id/followers` and `GET https://api.x.com/2/users/:id/following`

## Authentication Model

XLRrank uses OAuth 2.0 Authorization Code with PKCE for user authorization. The X adapter builds the provider authorization URL, exchanges authorization codes at `/2/oauth2/token`, verifies identity with `/2/users/me`, and supports refresh-token exchange when `offline.access` is granted.

Provider application credentials are deployment configuration, not user connection credentials. Client secrets are stored encrypted with AES-256-GCM and associated data bound to the provider configuration id, platform slug, and secret purpose.

OAuth authorization transactions are server-side rows. The browser receives only the provider authorization URL and random state value. The database stores the state digest, one-time PKCE verifier, requested scopes, actor, scope, platform, redirect target, timestamps, and consumption timestamp.

## Capability Matrix

| Capability       | Endpoint(s)                                                                                | Auth                        | Required scopes                            | Pagination             | Sprint status                                 |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------ | ---------------------- | --------------------------------------------- |
| profiles         | `/2/users/me`, `/2/users/:id`, `/2/users`, `/2/users/by/username/:username`, `/2/users/by` | OAuth 2.0 PKCE user context | `tweet.read`, `users.read`                 | none for single lookup | Implemented                                   |
| content          | `/2/users/:id/tweets`                                                                      | OAuth 2.0 PKCE user context | `tweet.read`, `users.read`                 | `meta.next_token`      | Implemented                                   |
| comments/replies | `/2/tweets/search/recent` using conversation/reply query semantics                         | OAuth 2.0 PKCE user context | `tweet.read`, `users.read`                 | `meta.next_token`      | Implemented for recent reply lookup           |
| search           | `/2/tweets/search/recent`; `/2/tweets/search/all` is access-gated                          | OAuth 2.0 PKCE user context | `tweet.read`, `users.read`                 | `meta.next_token`      | Recent search implemented; full archive gated |
| metrics          | User/Post `public_metrics` fields                                                          | OAuth 2.0 PKCE user context | `tweet.read`, `users.read`                 | none                   | Implemented for public metrics only           |
| followers        | `/2/users/:id/followers`                                                                   | OAuth 2.0 PKCE user context | `tweet.read`, `users.read`, `follows.read` | `meta.next_token`      | Implemented behind scope/access gate          |
| following        | `/2/users/:id/following`                                                                   | OAuth 2.0 PKCE user context | `tweet.read`, `users.read`, `follows.read` | `meta.next_token`      | Implemented behind scope/access gate          |

Capabilities are not globally marked available. API DTOs evaluate whether provider app configuration exists and whether the connection recorded the required granted OAuth scopes. Access-tier limitations are represented with `ACCESS_TIER_REQUIRED` where provider access, not implementation code, is the blocker.

## Rate Limits and Errors

The X transport parses `x-rate-limit-limit`, `x-rate-limit-remaining`, `x-rate-limit-reset`, and `retry-after`. HTTP 429 maps to the existing `RateLimitError`, which feeds the Sprint 05 worker retry scheduler. HTTP 5xx maps to retryable temporary provider failure. HTTP 401 maps to reauthorization unless refresh succeeds first. OAuth `invalid_grant` maps to `REAUTH_REQUIRED`; `invalid_client` maps to provider configuration failure.

## Worker Integration

The worker still uses the generic platform registry and connector factory. It does not branch on `platform === "x"`. OAuth tokens remain in the scoped encrypted social connection credential envelope and are never placed in Redis job payloads. When a token is near expiry, the worker uses the OAuth adapter refresh contract, verifies the refreshed identity, and replaces the encrypted credential envelope atomically under the existing database-backed sync lease and credential version check.

## Live Provider Gate

Ordinary PR CI uses deterministic X-shaped fixture tests and does not require X credentials.

Current live provider result:

```text
X LIVE PROVIDER GATE: BLOCKED_EXTERNAL
```

Reason: this repository does not contain real X app credentials or proof of an approved access tier. Live smoke verification must only run when credentials and access are supplied through approved CI/deployment secret storage. A passing fixture contract is engineering verification, not live X verification.

## Compliance Boundary

The connector avoids scraping, browser cookie reuse, private API automation, and raw response retention. It stores normalized records and redacted metadata according to the Sprint 04 raw-payload policy. X data retention, deletion/compliance streams, redistribution, and display-policy enforcement need a dedicated compliance sprint before claiming provider-policy compliance complete.
