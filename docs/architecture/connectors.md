# Capability-Driven Connectors

Laws 6 and 7. Reference implementation: `packages/shared/src/constitution/connectors.ts`.

## Model

- A connector publishes a **manifest**: id, platform, version, optional API version, and a
  capability map.
- Capabilities are a closed vocabulary: `profiles`, `content`, `comments`, `search`, `metrics`,
  `followers`, `following`, `audience_insights`, `messages`, `publishing`.
- Each capability carries an **availability state**:
  - `AVAILABLE` — implemented and callable now with current configuration.
  - `CONFIGURATION_REQUIRED` — implemented, but credentials/endpoint not configured.
  - `PERMISSION_REQUIRED` — implemented, but grants/scopes are missing.
  - `APP_REVIEW_REQUIRED` — implemented, but the platform has not approved the app yet.
  - `UNAVAILABLE` — not supported by this platform, or intentionally not built.

## Resource model

A connector exposes methods for the capabilities it declares. `getAuthenticatedProfile`,
`getProfile`, `getContent`, `getComments`, `getConversation`, `searchProfiles`, `searchContent`,
`getMetrics`, `getFollowers`, `getFollowing`, `getCommunities`, `getAudienceInsights` are the
initial method vocabulary. A method that maps to an `UNAVAILABLE` capability must not exist; a
method whose availability is `CONFIGURATION_REQUIRED`/`PERMISSION_REQUIRED`/`APP_REVIEW_REQUIRED`
returns a typed unavailable result — never fabricated data.

## Connector status

Runtime status is separate from capability availability: `CONNECTED`, `DISCONNECTED`,
`AUTHENTICATION_EXPIRED`, `PERMISSION_MISSING`, `RATE_LIMITED`, `CONFIGURATION_UNAVAILABLE`,
`HEALTHY`, `DEGRADED`. `DEMO` exists only for the demo provider mode and must visibly identify
itself.

## Anti-patterns

- Never silently scrape when the official API feature is unavailable.
- Never treat the browser extension as a mass data ingestion path.
- Never assume capability equality across platforms — inspect the manifest.