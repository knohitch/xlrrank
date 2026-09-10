# Reddit Connector

Verification date: 2026-09-10

Official sources checked:
- Reddit Responsible Builder Policy: https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy
- Reddit Data API Terms: https://redditinc.com/policies/data-api-terms
- Reddit API index: https://www.reddit.com/dev/api/
- Reddit API wiki / OAuth 2 technical reference: https://github.com/reddit-archive/reddit/wiki/oauth2

## Access Model

The connector is official-API-only. It does not scrape Reddit web pages and does not use browser automation. Current Reddit policy requires Data API approval before production access, and commercial or use-case-specific access must be explicitly authorized where applicable.

Capability states are evaluated from generic provider app configuration metadata:
- no enabled provider app config: `CONFIGURATION_REQUIRED`
- app config exists but Reddit Data API approval is not recorded: `APP_REVIEW_REQUIRED`
- Data API approval exists but required commercial/use-case authorization is absent: `ACCESS_TIER_REQUIRED`
- connected account lacks a required OAuth scope: `PERMISSION_REQUIRED`
- followers/following/audience/messages/publishing: `UNAVAILABLE`

Approval metadata is admin-controlled in `provider_app_configurations.metadata.access`; ordinary OAuth users cannot assert approval through OAuth start or callback parameters.

## OAuth

The connector uses Reddit authorization-code OAuth through the existing generic OAuth framework:
- authorization endpoint: `https://www.reddit.com/api/v1/authorize`
- token endpoint: `https://www.reddit.com/api/v1/access_token`
- revocation endpoint: `https://www.reddit.com/api/v1/revoke_token`
- bearer API base: `https://oauth.reddit.com`
- `duration=permanent`
- HTTP Basic client authentication for token, refresh, and revoke
- `application/x-www-form-urlencoded` token bodies
- no PKCE parameters

Default scopes are minimized to `identity`, `read`, and `history`. Submit, vote, edit, moderator, account, and private-message scopes are not requested by this connector.

Refresh preserves an existing refresh token when Reddit omits a replacement token.

## User-Agent And HTTP Safety

Every Reddit Data API request must have configured `userAgent` or `redditUserAgent` metadata. The connector fails closed for missing, too-short, or browser/client-spoofed User-Agent values.

Production hosts are fixed to:
- `https://www.reddit.com` for OAuth token/revoke
- `https://oauth.reddit.com` for bearer Data API calls

Localhost base URL overrides are allowed only outside production for tests.

## Implemented API Surface

Implemented read-oriented endpoints:
- `GET /api/v1/me`
- `GET /user/{username}/about.json`
- `GET /user/{username}/submitted.json`
- `GET /user/{username}/comments.json`
- `GET /comments/{article}.json`
- `GET /search.json`

Listings cap `limit` at Reddit's maximum of 100 and use opaque `after` cursors. Deleted and removed placeholder content is minimized at normalization time and is not persisted as durable user content.

The connector normalizes Reddit profiles, submissions, comments, and search results into the existing profile/content/interaction contracts. Provider metadata includes retention category, retention basis, and a source policy that blocks model training, fine-tuning, benchmark, and seed-data use by default.

## Retention

Reddit retention is data-policy-driven through `provider_data_retention_policies` migration `0012_reddit_retention_policies.sql`.

Default categories:
- `reddit_authenticated_user_profile`
- `reddit_public_user_profile`
- `reddit_user_content`
- `reddit_comment`

The default local maximum is 30 days absent a stricter configured approved-use-case rule. The production retention runtime discovers these categories generically through the existing Sprint 08 provider retention sweep.

## Webhooks And Disconnect

No Reddit webhook support is implemented because no official Reddit Data API webhook capability was verified.

Local disconnect uses the existing local-first connection lifecycle. Reddit has no provider event subscription cleanup row; disconnect returns after local state is marked `DISCONNECTED`, sync scheduling is disabled, and encrypted connection credentials are removed. Provider revocation is exposed by the connector adapter for bounded future cleanup flows, but local disconnect does not wait on provider network availability.

## Live Gate

`REDDIT LIVE PROVIDER GATE: BLOCKED_EXTERNAL`

No live Reddit client credentials, Data API approval, commercial/use-case approval, or production User-Agent registration were supplied for this sprint.
