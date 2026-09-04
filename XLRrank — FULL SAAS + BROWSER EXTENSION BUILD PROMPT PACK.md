# XLRrank — FULL SAAS + BROWSER EXTENSION BUILD PROMPT PACK

## HOW TO USE THIS PACK

You are building a complete production-grade application called **XLRrank**.

This is NOT an MVP.

Do not deliberately postpone major planned functionality for a later release.

Build the complete architecture described in this prompt pack before considering the product ready for public release.

Use every prompt IN ORDER.

For every prompt:

1. First inspect the existing repository.
2. Understand what is already implemented.
3. Do not destroy, replace, or regress working functionality.
4. Extend the existing architecture cleanly.
5. Do not fake integrations.
6. Do not return placeholder implementations and claim they work.
7. Run relevant tests, type checks, builds, migrations, and linting.
8. Fix failures before finishing the phase.
9. Update documentation.
10. At the end of every phase report:
   - what was created;
   - what was modified;
   - migrations added;
   - tests run;
   - tests passed/failed;
   - environment variables required;
   - external credentials still required;
   - any genuine external limitation.
11. Do not begin the next numbered phase until instructed.

External APIs that require credentials, approval, app review, or paid access must be implemented properly but marked unavailable until the administrator supplies valid access.

Never substitute fake live data for unavailable external APIs.

Demo data will be added deliberately near the END of this build and must be clearly identifiable as demo data.

---

# PROMPT 0 — PROJECT CONSTITUTION

You are the principal architect and senior engineer responsible for building **XLRrank**.

Before writing feature code, create and follow a project architecture constitution.

## PRODUCT

XLRrank is a platform-agnostic social, audience, relationship, content, and network intelligence platform.

It connects to multiple social platforms and AI providers.

It understands:

- people;
- social accounts;
- organizations;
- communities;
- posts;
- conversations;
- relationships;
- audiences;
- interests;
- expertise;
- content;
- topics;
- trends;
- opportunities;
- commercial intent;
- network movement;
- relationship history.

XLRrank tells a user:

- who they should know;
- which people matter;
- why those people matter;
- what conversations are worth entering;
- what conversations should be ignored;
- what topics are emerging;
- what their network is discussing;
- which relationships are warming;
- which relationships are cooling;
- what commercial opportunities may exist;
- what content gaps exist;
- what content they may be uniquely positioned to create;
- what actions deserve attention today.

Actual social actions remain human-controlled unless an official platform API explicitly permits an action and the product deliberately supports it.

Never implement mass-following, mass-liking, spam, vote manipulation, unauthorized mass messaging, or prohibited automation.

---

## REQUIRED APPLICATIONS

Use a monorepo.

Recommended conceptual layout:

apps/
  web/
  api/
  worker/
  extension/

packages/
  database/
  auth/
  ui/
  config/
  shared/
  social-core/
  ai-core/
  intelligence/
  observability/
  plugin-sdk/
  testing/

infra/
docs/

Use TypeScript throughout unless another language is objectively necessary for a specific subsystem.

Preferred stack:

- Next.js + React for web UI;
- NestJS or an equivalently structured TypeScript backend for API;
- PostgreSQL;
- pgvector;
- Redis;
- background job queues;
- S3-compatible object storage abstraction;
- React + TypeScript Manifest V3 browser extension;
- Docker Compose for canonical self-hosting.

Use current stable, compatible versions. Do not blindly upgrade packages if doing so breaks compatibility.

---

## ARCHITECTURAL LAW #1 — NOTHING PLATFORM-SPECIFIC IN THE CORE

Never create core concepts such as:

twitter_user
instagram_person
linkedin_contact

Use:

Person
SocialAccount
Platform
Content
Interaction
Organization
Community
Relationship
Topic
Opportunity

Platform-specific behavior belongs inside connectors.

---

## ARCHITECTURAL LAW #2 — PROVIDERS ARE ADAPTERS

Implement provider abstractions for:

Social platforms
AI providers
Embedding providers
Authentication providers where appropriate
Email
Object storage
Billing
Queues where appropriate

Core business logic must not directly depend on a commercial vendor.

---

## ARCHITECTURAL LAW #3 — OPEN-SOURCE READY

Assume this repository may be open-sourced tomorrow.

Therefore:

- no embedded API keys;
- no embedded secrets;
- no mandatory proprietary cloud provider;
- no hardcoded domain;
- no hardcoded platform IDs;
- no hardcoded LLM model names in business logic;
- no hardcoded subscription plans in business logic;
- no hardcoded scoring weights;
- no hardcoded relationship pipelines;
- no hardcoded deployment vendor;
- no secrets committed to Git.

Provide `.env.example`.

Self-hosting must be possible.

---

## ARCHITECTURAL LAW #4 — RAW DATA, FACTS AND AI INFERENCE ARE DIFFERENT

Every significant piece of intelligence must distinguish between:

OBSERVED
USER_PROVIDED
DERIVED
INFERRED

Example:

Follower count retrieved through an API = OBSERVED.

"Likely fintech investor" generated by AI = INFERRED.

Never mix these internally.

---

## ARCHITECTURAL LAW #5 — PROVENANCE

Important recommendations must remain explainable.

Store enough information to answer:

- what evidence created this result;
- which scoring version was used;
- which AI model was used;
- which prompt version was used;
- which source objects were used;
- when the result was generated.

---

## ARCHITECTURAL LAW #6 — CAPABILITY-DRIVEN CONNECTORS

A connector reports its abilities.

Example:

profiles
content
comments
search
metrics
followers
following
audience insights
messages
publishing

The application must check capabilities rather than assume every platform supports the same features.

---

## ARCHITECTURAL LAW #7 — NO FAKE SUCCESS

If LinkedIn, Meta, Reddit, X, or any other platform cannot provide a requested capability because credentials/permissions are unavailable:

return a clear unavailable state.

Never return invented live platform data.

---

## ARCHITECTURAL LAW #8 — EVENT-DRIVEN PROCESSING

Important system events should feed independent workers.

Examples:

CONTENT_INGESTED
PERSON_DISCOVERED
INTERACTION_INGESTED
RELATIONSHIP_UPDATED
MODEL_DISCOVERED
MODEL_UPDATED
OPPORTUNITY_DISCOVERED

Workers may then independently perform:

embeddings
classification
topic extraction
Social DNA updates
relationship updates
opportunity detection
trend calculations
analytics

---

## ARCHITECTURAL LAW #9 — AI IS NOT THE BUSINESS LOGIC

AI must not arbitrarily invent deterministic numerical scores.

Use:

structured data
mathematics
graph algorithms
configured scoring rules
statistical analysis

for deterministic operations.

Use LLMs for:

interpretation
classification
reasoning
language generation
semantic extraction
explanations

---

## ARCHITECTURAL LAW #10 — TEST EVERYTHING

Build:

unit tests
integration tests
API tests
authorization tests
connector tests
AI provider tests
worker tests
database tests
extension tests
end-to-end tests

External API calls should have deterministic test fixtures but production connectors must still contain genuine implementations.

Create the architecture documentation before moving forward.

Do not build superficial UI in this phase.

---

# PROMPT 1 — FOUNDATION, MONOREPO AND INFRASTRUCTURE

Implement the technical foundation.

Create:

- monorepo;
- shared TypeScript configuration;
- linting;
- formatting;
- test infrastructure;
- web app;
- API;
- worker;
- browser extension shell;
- PostgreSQL integration;
- pgvector extension;
- Redis integration;
- queue infrastructure;
- S3-compatible storage interface;
- local filesystem storage adapter;
- Dockerfiles;
- Docker Compose;
- health checks;
- environment validation;
- database migrations;
- structured logging.

Docker Compose should be capable of launching at minimum:

web
api
worker
postgres
redis

Create sensible development commands.

Examples:

install
dev
build
test
lint
typecheck
db:migrate
db:seed

Do not create fake platform integrations yet.

Acceptance criteria:

- repository installs cleanly;
- database starts;
- Redis starts;
- pgvector works;
- API health endpoint works;
- web app loads;
- worker loads;
- extension compiles;
- Docker Compose works;
- production build succeeds.

---

# PROMPT 2 — COMPLETE AUTHENTICATION AND AUTHORIZATION

Build REAL authentication.

Required flows:

## USER AUTH

- sign up;
- sign in;
- sign out;
- email verification;
- resend verification;
- forgot password;
- password reset;
- change password;
- account settings;
- active session management;
- revoke sessions;
- secure account deletion workflow.

Use strong password hashing such as Argon2id.

Protect against:

- brute force;
- credential stuffing patterns;
- account enumeration;
- session theft;
- CSRF where applicable;
- insecure token storage.

Use secure HTTP-only cookies where appropriate.

Tokens must have expiry and rotation where required.

Do not store authentication tokens in insecure browser storage when safer alternatives exist.

---

## ROLES

Implement RBAC.

Initial system roles:

USER
SUPPORT
ADMIN
SUPER_ADMIN

Do not hardcode authorization using scattered role comparisons.

Create permissions.

Examples:

user.profile.read
user.profile.update
support.ticket.read
support.ticket.respond
admin.users.read
admin.users.suspend
admin.providers.manage
admin.platforms.manage
admin.system.manage

Roles map to permissions.

---

## ADMIN AUTH

Admin URLs must not rely on obscurity for security.

Admin requires proper authorization.

Support:

- separate admin area;
- optional stronger session policies;
- optional MFA/TOTP architecture;
- audit sensitive actions.

---

## ACCOUNT STATUS

Support states such as:

ACTIVE
PENDING_VERIFICATION
SUSPENDED
DISABLED
DELETION_PENDING

Authorization must respect status.

Acceptance criteria:

Create automated tests proving:

- unauthorized users cannot access protected routes;
- normal users cannot access admin routes;
- support cannot perform super-admin operations;
- expired sessions fail;
- password reset works;
- email verification works;
- revoked sessions stop working.

---

# PROMPT 3 — USER, ADMIN AND SUPPORT PORTALS

Build the three operational experiences.

## USER APPLICATION

Create the authenticated application shell.

Navigation should be designed for:

Dashboard
Discover
Radar
Relationships
Intelligence
Content
Network
Search
Saved
Platforms
AI Providers
Reports
Notifications
Settings
Support

Use responsive professional SaaS UI.

Do not fill pages with meaningless charts simply to appear sophisticated.

Empty states must be useful.

---

## ADMIN APPLICATION

Admin needs:

Dashboard
Users
Organizations
Subscriptions
Usage
Social Platforms
AI Providers
Models
Jobs
Queues
System Health
Feature Flags
Support
Audit Logs
Configuration
Security
Data Management

Admin must be able to inspect system condition without accessing user secrets unnecessarily.

---

## SUPPORT APPLICATION

Create support functionality appropriate for a commercial SaaS.

User can:

- create ticket;
- choose category;
- set priority;
- attach files where supported;
- reply;
- see ticket history;
- close ticket.

Support role can:

- see assigned/unassigned tickets;
- claim tickets;
- reply;
- add internal notes;
- escalate;
- change priority;
- change status.

Ticket statuses:

OPEN
IN_PROGRESS
WAITING_FOR_USER
ESCALATED
RESOLVED
CLOSED

Maintain audit history.

Do not expose private account data to support unless permission explicitly allows it.

---

# PROMPT 4 — CORE DOMAIN DATABASE

Design and implement the normalized database.

Include appropriate entities such as:

users
sessions
roles
permissions
user_roles

organizations
organization_members

platforms
platform_connectors
social_accounts

people
person_identifiers
organizations_external

content
content_media
content_metrics
interactions
conversations

communities
community_memberships where available

topics
topic_clusters
content_topics

relationships
relationship_events
relationship_pipelines
relationship_stages

social_dna_profiles
social_dna_dimensions

opportunities
opportunity_types

trends
trend_snapshots

recommendations
recommendation_evidence
recommendation_feedback

ai_providers
ai_models
ai_model_capabilities
ai_model_benchmarks
ai_routes
ai_usage

prompt_definitions
prompt_versions

jobs
job_runs

audit_logs

support_tickets
support_messages

feature_flags

notifications

Create indexes thoughtfully.

Do not make every flexible field JSON.

Use JSONB for genuinely provider-specific or extensible metadata.

Create data retention and deletion architecture.

---

# PROMPT 5 — SOCIAL PLATFORM CONNECTOR FRAMEWORK

Create a plugin-capable social connector framework.

Initial first-class connectors:

X
Instagram
Facebook
LinkedIn
Reddit

Do NOT assume identical capabilities.

Each connector needs:

- manifest;
- authentication method;
- credential configuration;
- capability declaration;
- connection status;
- health check;
- rate-limit awareness;
- error normalization;
- data normalization;
- pagination;
- retry behavior;
- API version metadata where applicable.

Create a common connector interface.

Example conceptual capabilities:

getAuthenticatedProfile
getProfile
getContent
getComments
getConversation
searchProfiles
searchContent
getMetrics
getFollowers
getFollowing
getCommunities
getAudienceInsights

Only implement a method as available if the current official integration supports it.

Where access requires credentials or platform review:

complete the integration architecture and configuration flow but clearly report:

CONFIGURATION_REQUIRED
PERMISSION_REQUIRED
APP_REVIEW_REQUIRED
UNAVAILABLE

Never silently scrape in place of an unavailable API feature.

Design the browser extension separately from mass data ingestion.

---

# PROMPT 6 — PLATFORM CONNECTION UI AND DATA INGESTION

Build user-facing platform connection management.

User should be able to connect supported platforms.

Show:

Connected
Disconnected
Authentication expired
Permission missing
Rate limited
Configuration unavailable
Healthy
Degraded

Store external access credentials encrypted at rest.

Never display stored secrets again after entry.

Create ingestion pipelines.

Normalize platform objects into core entities.

Use idempotency.

Do not duplicate the same post every time ingestion runs.

Support incremental synchronization.

Track:

last successful sync
last attempted sync
cursor where supported
errors
rate limits

Create background jobs rather than blocking HTTP requests for large sync operations.

---

# PROMPT 7 — AI PROVIDER FRAMEWORK

Build a completely provider-neutral AI gateway.

FIRST-CLASS PROVIDERS:

OpenAI
Anthropic
DeepSeek
xAI / Grok
Xiaomi MiMo

GENERIC:

OpenAI-compatible provider

LOCAL:

Ollama/local-compatible implementation where practical.

Core application code must never invoke a vendor SDK directly.

Only provider adapters may do so.

Common capabilities should include:

text generation
reasoning
structured output
tool calling
vision
embeddings
streaming

Providers report capabilities.

---

## OPENAI-COMPATIBLE PROVIDER

Allow administrator/user configuration:

Name
Base URL
API Key
Authentication method
Custom headers
Model discovery URL if applicable
Protocol type
Timeout

Support:

automatic `/models` discovery when available;
manual model entry when discovery is unavailable.

This should allow gateways and proxies without code changes.

---

# PROMPT 8 — DYNAMIC MODEL REGISTRY AND MODEL UPDATE DETECTION

Implement the Model Registry Service.

NO model names may be embedded in routing business logic.

Periodically discover models from every configured provider.

Discovery occurs:

- application startup;
- configurable scheduled interval;
- manual refresh;
- stale-registry refresh.

Model lifecycle:

DISCOVERED
PROBING
VALIDATED
ACTIVE
DEPRECATED
RETIRED
QUARANTINED

When a new model appears:

do NOT immediately route production workload to it.

Run capability profiling.

Test:

text
structured output
instruction following
tool calling
streaming
vision if claimed
embeddings if claimed
target-language compliance
latency
basic reasoning
context behavior

Store:

provider
model ID
aliases
version
fingerprint where available
creation metadata
capabilities
context limits
pricing when available
last seen
last probed
health

Detect changed versions/fingerprints.

If an alias appears to have changed underneath, re-run validation.

Also create behavioral fingerprint tests to flag likely silent model changes.

---

# PROMPT 9 — REASONING TIER ENGINE AND AI ROUTER

Create reasoning tiers independent of provider names.

Initial conceptual tiers:

TIER_0_UTILITY
TIER_1_EVERYDAY
TIER_2_ADVANCED
TIER_3_DEEP_INTELLIGENCE
TIER_4_CRITICAL

Do NOT classify models merely because their marketing name contains:

Flash
Pro
Ultra
Advanced

Benchmark them.

Map real observed performance to capability/tier.

Examples:

Tier 0:
simple extraction
tagging
formatting
language detection

Tier 1:
summaries
routine classification
normal recommendations
basic Social DNA updates

Tier 2:
relationship analysis
content strategy
commercial-intent reasoning
cross-platform comparison

Tier 3:
network strategy
complex graph reasoning
multi-platform intelligence
high-ambiguity investigations

Tier 4:
highest-confidence complex work requiring verification or multi-model review.

---

## COMPLEXITY ESTIMATOR

A task has a default reasoning tier.

But calculate actual complexity using signals such as:

entity count
input size
relationship count
ambiguity
conflicting evidence
cross-platform breadth
requested depth

Automatically escalate when appropriate.

---

## ROUTING

Consider:

required capability
reasoning tier
benchmark quality
cost
latency
provider health
context window
language compliance
structured-output reliability

Modes:

AUTOMATIC
QUALITY_OPTIMIZED
COST_OPTIMIZED
CUSTOM

Allow fallback routing.

Allow administrator to set provider/model preferences per task.

---

# PROMPT 10 — LANGUAGE GUARD

Implement a provider-independent output language guard.

Default deployment language must be configurable.

For this project's default configuration:

English.

Chinese AI providers must NEVER accidentally expose Chinese generated prose to an English-configured user.

Do not rely exclusively on prompting.

Pipeline:

LLM
→ schema validation
→ language detection
→ script analysis
→ language policy validation
→ repair if necessary
→ revalidation
→ delivery

If generated content violates the configured language:

DO NOT DELIVER IT.

Repair it.

Preserve:

numbers
URLs
IDs
usernames
code
citations
structured meaning.

If repair fails after configured attempts:

use configured fallback model or return a controlled error.

Do not corrupt raw imported source content.

A Chinese post may remain Chinese as source data.

The language restriction applies to system-generated presentation/explanatory output.

Distinguish Chinese from Japanese appropriately rather than blindly blocking all CJK characters.

Make language policy configurable.

---

# PROMPT 11 — AI EVALUATION, HEALTH AND PROMPT REGISTRY

Build an internal model evaluation system.

Create benchmark datasets/tasks for:

Social DNA
topic classification
entity extraction
commercial-intent detection
relationship analysis
person relevance
opportunity detection
content analysis
trend explanation
structured output
language adherence

When new models are discovered:

benchmark them.

Record:

quality
latency
cost
reliability
schema adherence
language compliance

Do not automatically promote a newly discovered model merely because it is newer.

System can recommend routing changes.

Support optional shadow evaluation:

current production model answers normally;
candidate model processes a sample invisibly;
compare results.

---

## PROMPT VERSIONING

Prompts are production artifacts.

Store:

prompt ID
version
task
status
content/template
expected schema
created date
evaluation score

Never silently overwrite a production prompt.

---

# PROMPT 12 — SOCIAL DNA ENGINE

Build Social DNA.

Social DNA must be multi-dimensional and extensible.

Include concepts such as:

expertise
topics
interests
commercial interests
network interests
geography
audience types
content formats
communication style
tone
complexity
behavioral preferences

Generate DNA from:

profile information;
content;
comments;
engagement;
user configuration;
observed actions.

Separate:

STATED preferences

from:

OBSERVED preferences.

Use embeddings and structured analysis.

Track confidence.

Track historical versions so Social DNA changes can be analyzed over time.

Do not hardcode niches.

---

# PROMPT 13 — IDENTITY RESOLUTION AND KNOWLEDGE GRAPH

Create canonical Person entities.

A person may have multiple:

social accounts
websites
organizations
identifiers

Build identity matching using signals such as:

name
username
company
location
website
public profile links
bio similarity
content similarity

Never automatically merge uncertain identities.

Store confidence.

Allow:

confirmed
probable
uncertain
rejected

Create manual merge/split tools for administrators/users where appropriate.

---

## GRAPH

Model graph relationships including:

person → follows → person where available
person → interacts_with → person
person → works_at → organization
person → discusses → topic
person → belongs_to → community
person → connected_to → person

Start with PostgreSQL-backed graph representation.

Do not require Neo4j.

Keep graph abstraction clean enough for future alternative engines.

---

# PROMPT 14 — DISCOVERY AND EXPLAINABLE SCORING

Build Person Discovery.

Find people using:

Social DNA similarity
professional relevance
content similarity
network proximity
interaction quality
audience overlap
geography
commercial relevance
activity
conversation accessibility

Scoring MUST be deterministic/configurable.

Do not have an LLM invent the final percentage.

Create scoring configurations and versions.

Store component scores.

Example result:

Overall Fit: 91

Niche relevance: 94
Relationship value: 88
Content overlap: 91
Audience overlap: 76
Conversation accessibility: 82
Commercial relevance: 95

Then allow AI to explain:

WHY THIS PERSON?

Every explanation must use stored evidence.

Add recommendation feedback:

Useful
Not useful
Followed
Saved
Ignored
Wrong person
Wrong topic

Use this later for ranking improvements.

---

# PROMPT 15 — RELATIONSHIP INTELLIGENCE / SOCIAL CRM

Build relationship memory.

Every meaningful event may become a relationship event.

Examples:

followed
followed back
commented
replied
liked user's comment
mentioned
saved
DM interaction where legally/technically available
manual note
meeting
relationship stage change

Create configurable relationship pipelines.

Default example:

Discovered
Following
Engaged
Mutual Engagement
Familiar
Conversation
Relationship

Do NOT hardcode this workflow.

Users/installations may define their own.

Calculate separately:

Relationship Strength
Relationship Momentum

Example:

Strength 82
Momentum -31

means:

strong but cooling.

Surface:

relationships warming;
relationships cooling;
relationships requiring attention.

Allow notes, tags, priorities and relationship tiers.

Default strategic tiers may include:

Tier A
Tier B
Tier C

but keep them configurable.

---

# PROMPT 16 — OPPORTUNITY RADAR

Build the Opportunity Engine.

Support modular opportunity detectors.

Initial detectors:

Conversation Opportunity
Relationship Opportunity
Commercial Intent
Content Gap
Trend Opportunity
Collaboration Opportunity
Investment Opportunity
Hiring Opportunity
Media Opportunity

A detector combines:

freshness
semantic relevance
network value
commercial relevance
conversation saturation
author relevance
interaction accessibility
velocity
confidence

Do not create fake opportunities.

Store evidence.

Include:

WHY THIS MATTERS

RECOMMENDED ACTION

Examples:

Join conversation
Follow
Research
Reconnect
Save
Post
Ignore

Importantly, the system must sometimes recommend:

DO NOT ENGAGE.

Reasons could include:

low relevance;
oversaturated conversation;
poor strategic fit;
low-quality network;
high spam likelihood;
 stale conversation.

---

# PROMPT 17 — TREND AND NETWORK INTELLIGENCE

Build personalized trend detection.

Do NOT merely ask an LLM "what is trending?"

Use:

embedding clusters
topic volume
time-series statistics
velocity
network relevance
source quality

Distinguish:

global trend

from:

trend within user's network.

Detect:

topic acceleration
topic decline
new clusters
network migration
unusual common following behavior
new organizations repeatedly appearing

Example:

"Stablecoin settlement discussion increased sharply this week among African fintech accounts relevant to your Social DNA."

LLM explains the significance only after statistical detection.

---

# PROMPT 18 — CONTENT INTELLIGENCE

Build the Content Intelligence Engine.

Analyze:

topics
formats
tone
content archetype
performance
audience response
engagement quality
timing

Support platform-specific native formats without hardcoding them into the core.

Examples:

short post
thread
article
video
reel
carousel
photo

Create Content DNA.

Build Content Gap Engine:

Market interest
∩
Low content saturation
∩
User expertise
∩
Target audience interest
=
Content Opportunity

Generate:

topic
angle
why-now
recommended format
supporting evidence

Optionally generate drafts.

Do not turn the system into generic AI content spam.

---

# PROMPT 19 — CROSS-PLATFORM INTELLIGENCE

Combine information across X, Instagram, Facebook, LinkedIn and Reddit where legitimate data exists.

Examples:

same person across platforms;
same topic across platforms;
audience crossover;
relationship crossover;
content format crossover;
commercial signals appearing on multiple networks.

Create unified person pages.

Example:

Sarah Adams

X
LinkedIn
Instagram

Overall strategic relevance.

Show platform-specific evidence separately.

Never pretend an unavailable platform supplied data.

---

# PROMPT 20 — GLOBAL SEARCH / ASK XLRRANK

Build search across:

people
organizations
topics
communities
content
relationships
opportunities
trends

Support semantic + structured + graph-aware search.

Examples:

"Who should I know in African fintech?"

"Find founders discussing compliance."

"Which people in my network know investors focused on B2B SaaS?"

"Find people who recently complained about CRM pricing."

"Which relationships have cooled this month?"

Search responses require evidence and confidence.

---

# PROMPT 21 — DAILY INTELLIGENCE DASHBOARD

Build the primary dashboard.

The goal is:

Before the user opens X, LinkedIn, Instagram, Facebook or Reddit, they want to open XLRrank.

Possible dashboard structure:

Your Network Today

8 conversations worth joining
12 people worth knowing
3 relationships cooling
4 emerging topics
2 commercial opportunities
1 content gap

Priority Actions

1. Join this conversation
2. Re-engage this person
3. Discover this person
4. Research this organization
5. Post around this content gap

Include:

reason
confidence
evidence
recommended action

Avoid dashboard clutter.

Prioritize actionable intelligence.

---

# PROMPT 22 — BROWSER EXTENSION

Build the Chrome/Edge-compatible Manifest V3 extension.

The extension is NOT the intelligence engine.

It is an interface to XLRrank.

Use shared authentication securely.

When viewing supported social pages, where technically and legally appropriate:

detect current profile/content context;
send normalized identifiers/context to XLRrank API;
display available intelligence.

Example profile panel:

93% strategic fit
Relationship: Warming
Tier: A
11 network connections
Niche similarity: 96

Actions:

Save
View full intelligence
Add relationship note
Change relationship tier
Analyze
Open in XLRrank

Example post:

Conversation Opportunity: 88

Why:
Strong topic fit
Fresh conversation
Author frequently engages
Low saturation

Actions:

Analyze conversation
Save
Open opportunity

Never auto-click:

Follow
Like
Connect
Comment
Upvote
DM

unless an explicitly supported future feature is legally/platform permitted and intentionally enabled.

Do not build DOM mass scraping.

Extension must degrade gracefully when a site changes.

Keep selectors isolated and tested.

---

# PROMPT 23 — NOTIFICATIONS

Build notifications.

Possible channels through provider abstractions:

in-app
email
web push where supported

Notification categories:

high-value opportunity
relationship cooling
new model available
platform connection problem
provider failure
trend alert
support ticket update
security event

Users control preferences.

Avoid notification spam.

Allow digest mode.

---

# PROMPT 24 — COMMERCIALIZATION ARCHITECTURE

Prepare the application to operate commercially.

Do not require a billing provider in self-hosted deployments.

Build:

plans
subscriptions
entitlements
usage metering
limits
billing events

Use abstractions.

Example:

BillingProvider
├── StripeProvider
└── Manual/DisabledProvider

Do not scatter:

if plan == pro

throughout the application.

Use entitlements.

Examples:

intelligence.deep_reasoning
platform.instagram
ai.byok
reports.export
team.members
api.access

Plans are configuration/database records.

Support:

trial
active
past_due
cancelled
expired

Do not force commercial billing on open-source self-hosted installs.

---

# PROMPT 25 — BYOK AND AI COST MANAGEMENT

Support:

platform-managed AI

and

Bring Your Own Key.

Users/admin should be able to configure permitted AI providers.

Keys:

encrypted at rest;
masked;
never logged;
never returned in normal API responses.

Track:

tokens
requests
provider
model
task
cost estimate
latency
failures

Routing strategies:

Balanced
Quality
Cost
Custom

Allow AI budgets.

Example:

maximum daily cost;
maximum reasoning tier;
specific Tier 4 permission.

---

# PROMPT 26 — PRIVACY, SECURITY AND DATA GOVERNANCE

Perform serious security implementation.

Include:

encryption for sensitive credentials;
secret redaction;
rate limiting;
input validation;
output encoding;
CSRF protection;
secure cookies;
CORS policy;
authorization;
file upload validation;
audit logs;
session security;
API request limits;
webhook verification;
provider token encryption;
dependency scanning guidance.

Build user controls:

download my data
disconnect platform
delete imported platform data
delete AI provider key
delete account
data retention configuration where applicable

Self-hosted installations should remain capable of controlling their own data.

Document threat model.

---

# PROMPT 27 — OBSERVABILITY AND OPERATIONS

Build:

structured logs
metrics
job health
queue health
connector health
AI provider health
platform sync health
error tracking abstraction
system health dashboard

Track model/provider:

availability
latency
429 rate
5xx rate
schema failure
language failure
fallback frequency

Admin dashboard should surface degraded components.

Do not leak secrets into logs.

---

# PROMPT 28 — FEATURE FLAGS AND CONFIGURATION

Create config-driven feature management.

Support:

global flags
environment flags
organization flags where appropriate
user flags where appropriate

Feature flags are for safe engineering and release control, not for pretending unfinished features are finished.

Create configuration UI for:

platforms
AI providers
reasoning
language
scoring
relationship stages
retention
notifications
commercial settings

---

# PROMPT 29 — REPORTING AND EXPORT

Build useful reports.

Examples:

Network Growth
Relationship Health
Opportunity Performance
Topic Intelligence
Content Intelligence
Platform Comparison
AI Usage
Recommendation Outcomes

Allow appropriate export:

CSV
JSON
PDF later if implemented properly

Do not generate meaningless vanity reports.

---

# PROMPT 30 — COMPLETE TESTING PASS

Now perform a systematic test pass.

Do not seed demo data yet.

Test:

signup
verification
login
logout
reset password
session revocation
RBAC
admin
support
platform connector status
social data normalization
jobs
queues
AI provider configuration
generic OpenAI-compatible provider
model discovery
model capability tests
reasoning routing
fallback
language guard
Social DNA
identity resolution
discovery
relationship engine
opportunity engine
trend engine
content engine
global search
extension API communication
billing entitlement checks
privacy functions

Create integration tests for key user journeys.

Create browser/E2E tests.

Fix failures.

No known critical or high-severity application bug may be ignored.

---

# PROMPT 31 — DEMO DATA ENGINE

Only now add demo data.

Demo data must be clearly separated from real user data.

Create a deliberate demo/seed system.

Never silently inject demo records into production accounts.

Provide:

development seed;
optional demo workspace;
reset demo workspace.

Create realistic fictional entities.

Example user:

Founder/operator interested in:

African fintech
SaaS
business compliance
cross-border payments
CRM
AI

Generate fictional:

people
social profiles
organizations
posts
comments
relationships
topics
trend data
opportunities
relationship history
content performance
support ticket
notifications

Include multiple platforms:

X
Instagram
Facebook
LinkedIn
Reddit

Include:

strong recommendations;
weak recommendations;
warming relationships;
cooling relationships;
commercial opportunity;
content opportunity;
emerging trend;
poor engagement opportunity that should be ignored.

Demo data must exercise almost every major screen.

---

# PROMPT 32 — DEMO AI PROVIDER AND CONNECTOR MODE

Create an explicit demo provider mode.

Purpose:

Developers can run the UI without purchasing every external platform API.

Rules:

Demo mode MUST visibly identify itself.

It must never impersonate a live connector.

Example:

X
Status: DEMO

not:

X
Status: CONNECTED

Demo platform fixtures should implement the same normalized interfaces as real connectors so the application can be demonstrated.

Create demo AI fixtures for deterministic automated tests where required.

This does not replace real AI provider implementations.

---

# PROMPT 33 — UX POLISH

Now review the entire product as a real commercial SaaS.

Audit:

navigation
information hierarchy
loading states
empty states
error states
permission states
mobile responsiveness
accessibility
forms
tables
search
filters
tooltips
modals
notifications
status badges
provider health
demo indicators

Remove developer-looking UI.

Remove lorem ipsum.

Remove random placeholder dashboards.

Use consistent terminology.

Important terms include:

Social DNA
Discover
Radar
Relationships
Intelligence
Content
Network
Opportunity
Relationship Strength
Relationship Momentum
Reasoning Tier
AI Provider
Social Platform

Do not expose unnecessarily technical internals to normal users.

Admin may see deeper details.

---

# PROMPT 34 — EXTENSION POLISH AND CROSS-BROWSER REVIEW

Review extension.

Test:

authentication
session expiry
profile detection
content detection
API errors
unsupported pages
permission failures
XLRrank unavailable
platform UI changes
dark/light interfaces
popup
side panel if implemented
settings

No duplicate authentication system.

The extension should use the SaaS account securely.

Ensure build output can be packaged for Chrome/Edge.

Keep architecture suitable for future Firefox support.

---

# PROMPT 35 — OPEN-SOURCE READINESS AUDIT

Audit repository as if it will be published publicly tomorrow.

Check:

secrets
hardcoded domains
hardcoded AI vendors
hardcoded model names
hardcoded social platform assumptions
hardcoded billing plans
hardcoded storage vendor
private credentials
copyright-sensitive assets
internal-only URLs
machine-specific filesystem paths

Create:

README.md
CONTRIBUTING.md
SECURITY.md
architecture documentation
self-hosting documentation
environment variable documentation
provider development documentation
connector development documentation
plugin SDK documentation
database migration instructions
Docker instructions

A developer should understand how to:

add a new social connector;
add a new AI provider;
add an OpenAI-compatible endpoint;
add a new opportunity detector;
add a new scoring configuration;
self-host the project.

---

# PROMPT 36 — FINAL PRODUCTION AUDIT

Perform a final audit of the complete XLRrank repository.

Do NOT add large new features unless necessary to fix missing requirements.

Compare implementation against every requirement in Prompts 0–35.

Produce a requirement matrix:

Requirement
Implemented?
Location
Tests
Notes

Find:

unfinished stubs
TODOs
FIXMEs
fake implementations
unsafe mocks
hardcoded assumptions
dead routes
broken pages
missing migrations
security weaknesses
authorization gaps
unhandled API failures
unhandled provider failures
TypeScript errors
failing tests
broken extension builds
Docker issues

Fix what can be fixed.

Run:

clean install
lint
typecheck
unit tests
integration tests
E2E tests
production builds
extension build
database migrations
Docker build/startup tests

The project is not ready merely because the UI looks complete.

Only report READY when:

- authentication works;
- authorization works;
- user application works;
- admin application works;
- support works;
- social connector architecture works;
- real connectors are implemented to the extent official access permits;
- AI provider architecture works;
- generic OpenAI-compatible connection works;
- model discovery works;
- reasoning routing works;
- language guard works;
- intelligence engines work;
- extension works;
- demo mode works;
- self-hosting works;
- builds pass;
- tests pass.

If something requires external credentials or app approval, state that precisely without pretending otherwise.

---

# FINAL PRODUCT STANDARD

The end result should feel like a serious commercial product, not an AI-generated dashboard prototype.

A new user should be able to:

1. create an account;
2. verify it;
3. log in;
4. connect available social platforms;
5. connect/configure AI providers or use configured platform AI;
6. synchronize data;
7. obtain Social DNA;
8. discover relevant people;
9. understand why they matter;
10. view live/retrieved conversation opportunities where platform data permits;
11. manage relationships;
12. detect warming/cooling relationships;
13. see trends;
14. discover content gaps;
15. search their network;
16. receive daily intelligence;
17. use the browser extension while browsing supported sites;
18. contact support;
19. manage their account/privacy;
20. use the product without being exposed to unfinished developer internals.

An administrator should be able to:

1. manage users;
2. manage roles and permissions;
3. manage platform configurations;
4. manage AI providers;
5. inspect discovered AI models;
6. inspect capability tests;
7. manage routing;
8. manage reasoning tiers;
9. inspect provider health;
10. inspect jobs;
11. manage support;
12. manage features;
13. manage entitlements;
14. inspect audit logs;
15. diagnose failures;
16. control system configuration without editing source code.

The architecture must remain extensible enough that a developer can later add:

Threads
Bluesky
TikTok
YouTube
Mastodon
GitHub
newsletters
other networks

without rewriting XLRrank's intelligence core.

Likewise future models such as:

future GPT generations
future Claude generations
future DeepSeek generations
future Grok generations
future MiMo generations
new unknown providers

must be discoverable and usable without rewriting application business logic.

The AI models are interchangeable engines.

The platform's real intellectual property is:

Social DNA
Discovery
Network Intelligence
Relationship Intelligence
Opportunity Intelligence
Trend Intelligence
Content Intelligence
Identity Resolution
Scoring
Routing
Provenance
Cross-platform knowledge.

Build accordingly.