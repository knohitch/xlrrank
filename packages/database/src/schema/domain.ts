import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  integer,
  boolean,
  index,
  uniqueIndex,
  vector,
  primaryKey,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { users, platforms, aiProviders, aiModels, jobs } from "./auth.js";

export const socialAccounts = pgTable(
  "social_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platformId: uuid("platform_id")
      .notNull()
      .references(() => platforms.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    profileUrl: text("profile_url"),
    profileImageUrl: text("profile_image_url"),
    bio: text("bio"),
    location: text("location"),
    website: text("website"),
    ownerPersonId: uuid("owner_person_id"),
    followerCount: integer("follower_count"),
    followingCount: integer("following_count"),
    status: text("status").notNull().default("DISCONNECTED"),
    credentialsEncrypted: text("credentials_encrypted"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSyncAttemptAt: timestamp("last_sync_attempt_at", { withTimezone: true }),
    syncCursor: text("sync_cursor"),
    syncError: jsonb("sync_error"),
    rateLimitRemaining: integer("rate_limit_remaining"),
    rateLimitResetAt: timestamp("rate_limit_reset_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("social_accounts_platform_external_unique").on(
      t.platformId,
      t.externalId,
    ),
    uniqueIndex("social_accounts_platform_handle_unique").on(t.platformId, t.handle),
    index("social_accounts_user_idx").on(t.userId),
    index("social_accounts_status_idx").on(t.status),
  ],
);

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    bio: text("bio"),
    location: text("location"),
    website: text("website"),
    avatarUrl: text("avatar_url"),
    confidence: text("confidence").notNull().default("uncertain"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("people_name_idx").on(t.name)],
);

export const personIdentifiers = pgTable(
  "person_identifiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    identifierType: text("identifier_type").notNull(),
    identifierValue: text("identifier_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("person_identifiers_type_value_unique").on(
      t.identifierType,
      t.identifierValue,
    ),
    index("person_identifiers_person_idx").on(t.personId),
  ],
);

export const externalOrganizations = pgTable(
  "external_organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    website: text("website"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("external_orgs_name_idx").on(t.name)],
);

export const content = pgTable(
  "content",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platformId: uuid("platform_id")
      .notNull()
      .references(() => platforms.id, { onDelete: "cascade" }),
    authorAccountId: uuid("author_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    body: text("body").notNull(),
    contentType: text("content_type"),
    language: text("language"),
    externalCreatedAt: timestamp("external_created_at", { withTimezone: true }),
    embeddings: vector("embeddings", { dimensions: 1536 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("content_platform_external_unique").on(t.platformId, t.externalId),
    index("content_author_idx").on(t.authorAccountId),
    index("content_created_idx").on(t.externalCreatedAt),
  ],
);

export const contentMedia = pgTable(
  "content_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentId: uuid("content_id")
      .notNull()
      .references(() => content.id, { onDelete: "cascade" }),
    mediaType: text("media_type").notNull(),
    url: text("url"),
    mimeType: text("mime_type"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("content_media_content_idx").on(t.contentId)],
);

export const contentMetrics = pgTable(
  "content_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentId: uuid("content_id")
      .notNull()
      .references(() => content.id, { onDelete: "cascade" }),
    likes: integer("likes").default(0),
    comments: integer("comments").default(0),
    shares: integer("shares").default(0),
    impressions: integer("impressions").default(0),
    engagementRate: doublePrecision("engagement_rate"),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("content_metrics_content_idx").on(t.contentId)],
);

export const interactions = pgTable(
  "interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platformId: uuid("platform_id")
      .notNull()
      .references(() => platforms.id, { onDelete: "cascade" }),
    fromAccountId: uuid("from_account_id").references(() => socialAccounts.id),
    toContentId: uuid("to_content_id")
      .references(() => content.id, { onDelete: "cascade" }),
    toAccountId: uuid("to_account_id").references(() => socialAccounts.id),
    type: text("type").notNull(),
    externalId: text("external_id"),
    body: text("body"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("interactions_platform_external_unique").on(t.platformId, t.externalId),
    index("interactions_from_idx").on(t.fromAccountId),
    index("interactions_to_content_idx").on(t.toContentId),
    index("interactions_occurred_idx").on(t.occurredAt),
  ],
);

export const communities = pgTable(
  "communities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    platformId: uuid("platform_id").references(() => platforms.id),
    slug: text("slug"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("communities_name_idx").on(t.name)],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalId: text("external_id"),
    platformId: uuid("platform_id").references(() => platforms.id),
    title: text("title"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conversations_platform_external_unique").on(
      t.platformId,
      t.externalId,
    ),
    index("conversations_created_idx").on(t.createdAt),
  ],
);

export const topics = pgTable(
  "topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    slug: text("slug").notNull(),
    parentTopicId: uuid("parent_topic_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("topics_slug_unique").on(t.slug),
    index("topics_label_idx").on(t.label),
  ],
);

export const topicClusters = pgTable(
  "topic_clusters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("topic_clusters_name_idx").on(t.name)],
);

export const contentTopics = pgTable(
  "content_topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentId: uuid("content_id")
      .notNull()
      .references(() => content.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    confidence: doublePrecision("confidence"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("content_topics_unique").on(t.contentId, t.topicId),
    index("content_topics_topic_idx").on(t.topicId),
  ],
);

export const relationshipPipelines = pgTable(
  "relationship_pipelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    config: jsonb("config"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("relationship_pipelines_name_unique").on(t.name)],
);

export const relationshipStages = pgTable(
  "relationship_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => relationshipPipelines.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    orderIndex: integer("order_index").notNull(),
    color: text("color"),
  },
  (t) => [
    uniqueIndex("relationship_stages_pipeline_key_unique").on(t.pipelineId, t.key),
    index("relationship_stages_pipeline_idx").on(t.pipelineId),
  ],
);

export const relationships = pgTable(
  "relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fromPersonId: uuid("from_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    toPersonId: uuid("to_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    pipelineId: uuid("pipeline_id").references(() => relationshipPipelines.id),
    stageKey: text("stage_key"),
    strength: doublePrecision("strength"),
    momentum: doublePrecision("momentum"),
    tier: text("tier"),
    notes: text("notes"),
    tags: jsonb("tags"),
    priority: text("priority"),
    lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("relationships_from_to_unique").on(
      t.fromPersonId,
      t.toPersonId,
      t.userId,
    ),
    index("relationships_user_idx").on(t.userId),
    index("relationships_pipeline_stage_idx").on(t.pipelineId, t.stageKey),
  ],
);

export const relationshipEvents = pgTable(
  "relationship_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    relationshipId: uuid("relationship_id")
      .notNull()
      .references(() => relationships.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    description: text("description"),
    metadata: jsonb("metadata"),
    sourceKind: text("source_kind").notNull().default("OBSERVED"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("relationship_events_rel_idx").on(t.relationshipId),
    index("relationship_events_occurred_idx").on(t.occurredAt),
  ],
);

export const socialDnaProfiles = pgTable(
  "social_dna_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    dimensions: jsonb("dimensions").notNull(),
    confidence: jsonb("confidence"),
    sourceKind: text("source_kind").notNull().default("DERIVED"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("social_dna_person_version_idx").on(t.personId, t.version),
  ],
);

export const relationships_person = relationships;

export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    typeKey: text("type_key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    recommendedAction: text("recommended_action"),
    doNotEngage: boolean("do_not_engage").notNull().default(false),
    score: doublePrecision("score"),
    confidence: doublePrecision("confidence"),
    evidence: jsonb("evidence"),
    metadata: jsonb("metadata"),
    status: text("status").notNull().default("OPEN"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("opportunities_user_idx").on(t.userId),
    index("opportunities_type_idx").on(t.typeKey),
    index("opportunities_status_idx").on(t.status),
  ],
);

export const trends = pgTable(
  "trends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id").references(() => topics.id, { onDelete: "set null" }),
    scope: text("scope").notNull().default("GLOBAL"),
    label: text("label").notNull(),
    velocity: doublePrecision("velocity"),
    acceleration: doublePrecision("acceleration"),
    status: text("status").default("EMERGING"),
    metadata: jsonb("metadata"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trends_user_topic_idx").on(t.userId, t.topicId)],
);

export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetPersonId: uuid("target_person_id").references(() => people.id),
    recommendationType: text("recommendation_type").notNull(),
    overallScore: doublePrecision("overall_score"),
    componentScores: jsonb("component_scores"),
    scoringVersion: text("scoring_version"),
    explanation: text("explanation"),
    evidence: jsonb("evidence"),
    status: text("status").notNull().default("PENDING"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recommendations_user_idx").on(t.userId)],
);

export const recommendationFeedback = pgTable(
  "recommendation_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id, { onDelete: "cascade" }),
    feedbackType: text("feedback_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recommendation_feedback_rec_idx").on(t.recommendationId)],
);

export const platformConnectors = pgTable(
  "platform_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platformId: uuid("platform_id")
      .notNull()
      .references(() => platforms.id, { onDelete: "cascade" }),
    connectorType: text("connector_type").notNull(),
    version: text("version").notNull().default("0.1.0"),
    config: jsonb("config"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("platform_connectors_platform_unique").on(t.platformId)],
);

export const communityMemberships = pgTable(
  "community_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    role: text("role"),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("community_memberships_unique").on(t.communityId, t.socialAccountId),
    index("community_memberships_account_idx").on(t.socialAccountId),
  ],
);

export const trendSnapshots = pgTable(
  "trend_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trendId: uuid("trend_id")
      .notNull()
      .references(() => trends.id, { onDelete: "cascade" }),
    velocity: doublePrecision("velocity"),
    volume: integer("volume"),
    acceleration: doublePrecision("acceleration"),
    metadata: jsonb("metadata"),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trend_snapshots_trend_idx").on(t.trendId)],
);

export const recommendationEvidence = pgTable(
  "recommendation_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id, { onDelete: "cascade" }),
    evidenceType: text("evidence_type").notNull(),
    sourceKind: text("source_kind").notNull().default("OBSERVED"),
    entityId: text("entity_id"),
    description: text("description"),
    weight: doublePrecision("weight"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recommendation_evidence_rec_idx").on(t.recommendationId)],
);

export const aiRoutes = pgTable(
  "ai_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskType: text("task_type").notNull(),
    tier: text("tier"),
    providerId: uuid("provider_id")
      .references(() => aiProviders.id, { onDelete: "set null" }),
    modelId: uuid("model_id")
      .references(() => aiModels.id, { onDelete: "set null" }),
    priority: integer("priority").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_routes_task_idx").on(t.taskType)],
);

export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    providerId: uuid("provider_id").references(() => aiProviders.id, { onDelete: "set null" }),
    modelId: text("model_id"),
    taskType: text("task_type"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    costEstimate: doublePrecision("cost_estimate"),
    latencyMs: integer("latency_ms"),
    success: boolean("success").notNull().default(true),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_usage_user_idx").on(t.userId),
    index("ai_usage_provider_idx").on(t.providerId),
    index("ai_usage_created_idx").on(t.createdAt),
  ],
);

export const promptDefinitions = pgTable(
  "prompt_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskType: text("task_type").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("prompt_definitions_name_unique").on(t.name),
    index("prompt_definitions_task_idx").on(t.taskType),
  ],
);

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => promptDefinitions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    expectedSchema: jsonb("expected_schema"),
    evaluationScore: doublePrecision("evaluation_score"),
    status: text("status").notNull().default("DRAFT"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("prompt_versions_unique").on(t.promptId, t.version),
    index("prompt_versions_prompt_idx").on(t.promptId),
  ],
);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull().default(1),
    status: text("status").notNull().default("RUNNING"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: jsonb("error"),
    result: jsonb("result"),
  },
  (t) => [
    index("job_runs_job_idx").on(t.jobId),
    index("job_runs_status_idx").on(t.status),
  ],
);
