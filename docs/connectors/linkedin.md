# LinkedIn Production Connector

Sprint 08 establishes the official, production-grade LinkedIn integration in XLRrank adhering strictly to official Microsoft / LinkedIn documentation crawled and verified on 2026-09-09.

## Official Specifications and Baseline

- **API Baseline**: LinkedIn Marketing Developer Platform Version `202608` (released monthly in `YYYYMM` format).
- **Transport Protocol**: Rest.li `2.0.0` (enforced via `X-Restli-Protocol-Version: 2.0.0` and `Linkedin-Version: 202608`).
- **REST API Base URL**: `https://api.linkedin.com/rest/`
- **OAuth Authorization Endpoint**: `https://www.linkedin.com/oauth/v2/authorization`
- **OAuth Token Endpoint**: `https://www.linkedin.com/oauth/v2/accessToken`
- **OpenID Connect Userinfo**: `https://api.linkedin.com/v2/userinfo`
- **Official Documentation**:
  - Marketing API Overview: `https://learn.microsoft.com/en-us/linkedin/marketing/`
  - Versioning: `https://learn.microsoft.com/en-us/linkedin/marketing/versioning`
  - Organization Access Control: `https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control`
  - Organization Lookup API: `https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api`
  - Posts API: `https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api`
  - Social Actions API: `https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/social-actions-api`
  - Network Sizes & Follower Stats: `https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/follower-statistics`
  - Webhooks & Notifications: `https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/organization-social-action-notifications`

---

## Authentication and Authorization Model

1. **3-Legged Member OAuth 2.0**:
   - The user authorizes via the official LinkedIn authorization endpoint with application-scoped state digest, redirect URI, and requested scopes.
   - Authorization codes are exchanged server-side via `POST /oauth/v2/accessToken`.
   - Access tokens and optional refresh tokens are encrypted at rest with AES-256-GCM and AAD bound to the authorization ID, scope ID, and provider family.

2. **OpenID Connect Identity**:
   - Authenticated member identity is resolved via `GET /v2/userinfo`.
   - The `sub` claim provides the immutable provider user ID.
   - **Compliance Notice**: As mandated by Architectural Law #7, the member `sub` identifier and profile attributes represent the provider account identity only and are **never** advertised or represented as real-world KYC verification.

3. **Organization Asset Discovery**:
   - Following token exchange, the connector discovers administered organizations via `GET /rest/organizationAcls?q=roleAssignee`.
   - Organization metadata is resolved via `GET /rest/organizations/{id}`.
   - Discovered Organization Pages are stored in `provider_authorization_assets` with `asset_type = 'LINKEDIN_ORGANIZATION'` and `token_kind = 'USER'`.
   - The user explicitly selects which organization assets to connect, preventing unsolicited asset linking and guaranteeing tenant isolation and IDOR protection.

---

## Capability Matrix and Truthfulness

In compliance with Architectural Laws #6 and #7, the connector strictly distinguishes between locally supported capabilities and external access permissions:

| Capability | Endpoints | Required Scopes / Roles | Rate Limits / Pagination | Status |
|---|---|---|---|---|
| **Organization Profile** | `GET /rest/organizations/{id}` | Member role (`ADMINISTRATOR`, `ANALYST`, etc.) | Standard Rest.li limits | **LOCAL VERIFIED** |
| **Organization Posts** | `GET /rest/posts?author=urn:li:organization:{id}&q=author` | `r_organization_social` or `r_organization_admin` | Opaque cursor (`start`, `count`) | **LOCAL VERIFIED** |
| **Comments & Interactions** | `GET /rest/socialActions/{activityUrn}/comments` | `r_organization_social` | Opaque cursor (`start`, `count`) | **LOCAL VERIFIED** |
| **Organization Network Size** | `GET /rest/networkSizes/urn:li:organization:{id}` | Organization administrator or analyst role | Direct endpoint | **LOCAL VERIFIED** |
| **Follower Statistics** | `GET /rest/organizationalEntityFollowerStatistics` | Organization role | Rest.li URN query | **LOCAL VERIFIED** |
| **Share Statistics** | `GET /rest/organizationalEntityShareStatistics` | Organization role | Rest.li URN query | **LOCAL VERIFIED** |
| **Member Social Feed** | `GET /rest/memberShares` | `r_member_social_feed` (Partner Approval Required) | Opaque cursor | **APP_REVIEW_REQUIRED** |
| **Follower Identity Lists** | *None* | LinkedIn does not expose open follower lists | Not available in API | **UNAVAILABLE** |
| **Following Identity Lists** | *None* | Organizations cannot follow other members | Not available in API | **UNAVAILABLE** |
| **General Social Search** | *None* | No unrestricted public search API | Not available in API | **UNAVAILABLE** |

Dynamic capability evaluation (`evaluateLinkedInCapabilities`) checks both the granted scopes and the user's assigned organization roles:
- An `ANALYST` role receives metrics capabilities but is denied content publishing.
- An `ADMINISTRATOR` or `CONTENT_ADMINISTRATOR` receives both content and metric observation rights.

---

## Webhooks and Notifications

1. **Challenge-Response Handshake**:
   - `GET /platforms/:id/linkedin/webhook?challengeCode={code}`
   - Computes `HMAC-SHA256(challengeCode, clientSecret)` and returns `{ challengeCode, challengeResponse }`.
2. **Notification Delivery & Verification**:
   - `POST /platforms/:id/linkedin/webhook` (marked `@Public()` and `@CsrfExempt()`).
   - Validates `X-LI-Signature` header (supporting raw hex, `sha256=`, and `hmacsha256=` prefixes) using timing-safe comparison.
3. **Durable Receipt & Outbox Pipeline**:
   - Persists receipt in `webhook_receipts` with `provider_family = 'linkedin'` and deduplication key.
   - Enqueues `social.webhook.process` job into outbox and BullMQ.
   - Worker extracts organization URN from notification payload, matches active social connections by `providerAssetId`, enqueues sync requests, and marks receipt `PROCESSED`.

---

## Data Storage and Retention Policies

LinkedIn Marketing API terms mandate strict data retention limits:
- **Member Data**: Maximum 24 hours (`TRANSIENT_24H`).
- **Organization Profile & Content**: Maximum 56 days (8 weeks, `ORGANIZATION_CONTENT_56D`).
- **Analytics & Statistics**: Maximum 30 days (`ANALYTICS_30D`).
- **Webhook Receipts**: Maximum 7 days (`WEBHOOK_RECEIPT_7D`).

### Implementation:
- Forward migration `0007_linkedin_retention_policies.sql` created table `provider_data_retention_policies` seeded with LinkedIn rules.
- Helper `purgeExpiredProviderData` enforces retention cutoffs safely:
  - Distinguishes organization content from member content via `provider_metadata->>'assetType'`.
  - Cleans expired observations per scope.
  - Deletes orphaned canonical content items **only if** no other lawful scope retains an observation.

---

## Error Handling and Role Degradation

- **HTTP 401**: Maps to `AuthenticationError` -> transitions connection to `REAUTH_REQUIRED`.
- **HTTP 403 (Role Loss / Access Control)**: Maps to `AuthorizationError("NON_RETRYABLE")` -> transitions connection to `DEGRADED` rather than infinite retry or reauth loops.
- **HTTP 403 (Product Review Required)**: Indicates missing LinkedIn Partner Program approvals.
- **HTTP 429**: Maps to `RateLimitError` with retry delay from `Retry-After` header -> worker delays job via BullMQ backoff.
- **HTTP 5xx**: Maps to `TemporaryProviderError` -> worker retries with exponential backoff and jitter.

---

## Live Provider Gate

```text
LINKEDIN LIVE PROVIDER GATE: BLOCKED_EXTERNAL
```

**Reason**: This repository does not contain production LinkedIn Developer Application credentials or LinkedIn Partner Program Community Management approvals. All local contract, OAuth lifecycle, asset discovery, worker BullMQ ingestion, pagination, comments, metrics, webhook delivery, deduplication, and retention policies are fully verified using deterministic HTTP fixtures and real PostgreSQL/Redis services. Live verification requires credentials provisioned through secure CI secret storage.
