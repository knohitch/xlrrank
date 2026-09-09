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
  - Organization Social Action Notifications: `https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-social-action-notifications`
  - Webhook Validation: `https://learn.microsoft.com/linkedin/shared/api-guide/webhook-validation`
  - Data Storage Requirements: `https://learn.microsoft.com/linkedin/marketing/data-storage-requirements`

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
| **Organization Network Size** | `GET /rest/networkSizes/urn:li:organization:{id}` | Product access + organization role | Direct endpoint | **LOCAL VERIFIED** |
| **Follower Statistics** | `GET /rest/organizationalEntityFollowerStatistics` | Product access + administrator role | Rest.li URN query | **ACCESS_REQUIRED unless enabled** |
| **Share Statistics** | `GET /rest/organizationalEntityShareStatistics` | Product access + administrator role | Rest.li URN query | **LOCAL VERIFIED when enabled** |
| **Member Social Feed** | `GET /rest/memberShares` | `r_member_social_feed` (Partner Approval Required) | Opaque cursor | **APP_REVIEW_REQUIRED** |
| **Follower Identity Lists** | *None* | LinkedIn does not expose open follower lists | Not available in API | **UNAVAILABLE** |
| **Following Identity Lists** | *None* | Organizations cannot follow other members | Not available in API | **UNAVAILABLE** |
| **General Social Search** | *None* | No unrestricted public search API | Not available in API | **UNAVAILABLE** |

Dynamic capability evaluation (`evaluateLinkedInCapabilities`) checks implementation support, trusted operator/provider app access state, granted scopes, and the user's organization role. Product access flags are deployment metadata and are not end-user toggles. Follower identity lists are always `UNAVAILABLE`; total follower count is an aggregate metric from `networkSizes`, and demographic audience insights are only available when follower-statistics access is actually implemented and approved.

---

## Webhooks and Notifications

1. **Challenge-Response Handshake**:
   - `GET /platforms/:id/linkedin/webhook?challengeCode={code}`
   - Computes `HMAC-SHA256(challengeCode, clientSecret)` and returns `{ challengeCode, challengeResponse }`.
2. **Notification Delivery & Verification**:
   - `POST /platforms/:id/linkedin/webhook` (marked `@Public()` and `@CsrfExempt()`).
   - Requires the exact raw request body bytes. Missing raw body fails closed before any receipt, outbox, or business write.
   - Validates `X-LI-Signature` using the official string-to-sign: UTF-8 `hmacsha256=` prefix prepended to the exact raw JSON body, then HMAC-SHA256 with the LinkedIn app client secret.
   - The header value must be the lowercase hex digest only. `sha256=<digest>` and `hmacsha256=<digest>` header formats are rejected.
3. **Durable Receipt & Outbox Pipeline**:
   - Persists a minimized receipt in `webhook_receipts` with `provider_family = 'linkedin'`, `provider_data_category = 'webhook_operational_receipt'`, and a deduplication key.
   - Enqueues `social.webhook.process` job into outbox and BullMQ.
   - Worker extracts organization URN from notification payload, matches active social connections by `providerAssetId`, enqueues sync requests, and marks receipt `PROCESSED`.

4. **Organization Social Action Event Subscriptions**:
   - Local support uses the LinkedIn Event Subscription API:
     `PUT /rest/eventSubscriptions/(developerApplication:{developerApplicationUrn},user:{memberUrn},entity:{organizationUrn},eventType:ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS)`.
   - Creation requires `rw_organization_admin`, authenticated member identity, `ADMINISTRATOR` organization access, trusted notification product/access metadata, developer application URN, organization URN, event type, and webhook URL.
   - Subscriptions are stored in `provider_event_subscriptions` and linked to the provider authorization, authorization asset, social connection, scope, member, organization, developer application, event type, and provider status.
   - Disconnect deactivates only the relevant local subscription. Loss of grant, role, or product access marks the subscription and connection degraded/inactive without revoking independent LinkedIn grants or retrying in a hot loop.
   - Live webhook registration and notification product access remain external LinkedIn developer-portal operations:
     `LINKEDIN WEBHOOK REGISTRATION: BLOCKED_EXTERNAL`,
     `LINKEDIN NOTIFICATION LIVE ACCESS: BLOCKED_EXTERNAL`.

---

## Data Storage and Retention Policies

LinkedIn Marketing API terms require retention by precise data category. The shortest applicable LinkedIn category wins when records overlap:

| Data Category | Local Category | Duration Source |
|---|---|---|
| Authenticated member Person ID / URN | `authenticated_member_id` | No provider duration restriction |
| Authenticated member profile | `authenticated_member_profile` | No provider duration restriction; consent, deletion, and revocation obligations still apply |
| Other member Person ID / URN | `other_member_id` | No provider duration restriction |
| Other member profile | `other_member_profile` | 24-hour cache only |
| Member social activity | `member_social_activity` | 48 hours |
| Organization social activity | `organization_social_activity` | Six weeks |
| Organization social activity for an authenticated organization asset | `organization_social_activity_authenticated_org` | Six months |
| Organization profile for an authenticated organization asset | `organization_profile` | Eight weeks |
| Limited non-authenticated organization profile fields | `organization_profile_limited` | 30 days |
| Organization Pages admin/reporting data | `organization_admin_reporting` | One year |
| Minimal webhook receipt metadata | `webhook_operational_receipt` | `XLRRANK_OPERATIONAL_RETENTION`, not LinkedIn-mandated retention |

### Implementation:
- Forward migration `0008_linkedin_retention_subscriptions_truthfulness.sql` corrects the Sprint 08 retention model without editing historical migration `0007`.
- `retention_mode` and nullable `max_retention_seconds` represent categories with no provider duration restriction without arbitrary large numbers.
- Helper `purgeExpiredProviderData` enforces retention cutoffs safely:
  - Classifies profiles, content, interactions, metrics, and webhook receipts per provider datum using generic `provider_data_category` fields.
  - Treats member comments on organization posts as member social activity, not organization content.
  - Purges comments/replies/reactions via interaction observations and deletes orphaned canonical interaction records only when no lawful observation remains.
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
