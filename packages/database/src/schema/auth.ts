import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  uuid,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
  vector,
  primaryKey,
} from "drizzle-orm/pg-core";
import { accountStatusEnum, roleEnum } from "./enums.js";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    status: accountStatusEnum("status").notNull().default("PENDING_VERIFICATION"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email), index("users_status_idx").on(t.status)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_unique").on(t.tokenHash),
    index("sessions_user_id_idx").on(t.userId),
  ],
);

export const emailTokens = pgTable(
  "email_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("email_tokens_user_idx").on(t.userId),
    index("email_tokens_purpose_idx").on(t.purpose),
  ],
);

export const roles = pgTable("roles", {
  name: roleEnum("name").primaryKey(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("permissions_key_unique").on(t.key)],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleName: roleEnum("role_name")
      .notNull()
      .references(() => roles.name, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleName, t.permissionId] }),
    index("role_permissions_permission_idx").on(t.permissionId),
  ],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleName: roleEnum("role_name")
      .notNull()
      .references(() => roles.name, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleName] })],
);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    website: text("website"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("organizations_name_idx").on(t.name)],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("org_members_unique").on(t.organizationId, t.userId),
    index("org_members_user_idx").on(t.userId),
  ],
);

export const organizationMemberPermissions = pgTable(
  "organization_member_permissions",
  {
    memberId: uuid("member_id")
      .notNull()
      .references(() => organizationMembers.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.memberId, t.capability] }),
    index("org_member_permissions_capability_idx").on(t.capability),
  ],
);

export const platforms = pgTable(
  "platforms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    providerFamily: text("provider_family"),
    displayName: text("display_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("platforms_slug_unique").on(t.slug)],
);

export const aiProviders = pgTable(
  "ai_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    protocol: text("protocol").notNull(),
    baseUrl: text("base_url"),
    apiKeyEncrypted: text("api_key_encrypted"),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_providers_slug_unique").on(t.slug)],
);

export const aiModels = pgTable(
  "ai_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => aiProviders.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    displayName: text("display_name"),
    version: text("version"),
    fingerprint: text("fingerprint"),
    lifecycleStage: text("lifecycle_stage").notNull().default("DISCOVERED"),
    capabilities: jsonb("capabilities"),
    contextLimit: integer("context_limit"),
    pricing: jsonb("pricing"),
    health: jsonb("health"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastProbedAt: timestamp("last_probed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_models_provider_model_unique").on(t.providerId, t.modelId),
    index("ai_models_stage_idx").on(t.lifecycleStage),
  ],
);

export const aiModelBenchmarks = pgTable(
  "ai_model_benchmarks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    modelId: uuid("model_id")
      .notNull()
      .references(() => aiModels.id, { onDelete: "cascade" }),
    taskType: text("task_type").notNull(),
    quality: integer("quality"),
    latencyMs: integer("latency_ms"),
    successRate: integer("success_rate"),
    languageCompliance: integer("language_compliance"),
    schemaAdherence: integer("schema_adherence"),
    benchmarkedAt: timestamp("benchmarked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("model_benchmarks_model_idx").on(t.modelId)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    status: text("status").notNull().default("QUEUED"),
    payload: jsonb("payload"),
    error: jsonb("error"),
    queueName: text("queue_name"),
    payloadVersion: integer("payload_version"),
    scopeId: uuid("scope_id"),
    connectionId: uuid("connection_id"),
    reason: text("reason"),
    idempotencyKey: text("idempotency_key"),
    bullmqJobId: text("bullmq_job_id"),
    retryClassification: text("retry_classification"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    ingestionRunId: uuid("ingestion_run_id"),
    safeError: jsonb("safe_error"),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_status_idx").on(t.status),
    index("jobs_type_idx").on(t.type),
    index("jobs_user_idx").on(t.userId),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    ipAddress: text("ip_address"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_actor_idx").on(t.actorUserId),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);

export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id),
    category: text("category"),
    priority: text("priority").notNull().default("MEDIUM"),
    status: text("status").notNull().default("OPEN"),
    subject: text("subject").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("support_tickets_user_idx").on(t.userId),
    index("support_tickets_status_idx").on(t.status),
    index("support_tickets_assigned_idx").on(t.assignedToUserId),
  ],
);

export const supportMessages = pgTable(
  "support_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    senderUserId: uuid("sender_user_id").references(() => users.id),
    body: text("body").notNull(),
    isInternal: boolean("is_internal").notNull().default(false),
    attachments: jsonb("attachments"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("support_messages_ticket_idx").on(t.ticketId)],
);

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    scope: text("scope").notNull().default("GLOBAL"),
    enabled: boolean("enabled").notNull().default(false),
    targetUserId: uuid("target_user_id").references(() => users.id),
    targetOrgId: uuid("target_org_id").references(() => organizations.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("feature_flags_key_scope_unique").on(t.key, t.scope),
    index("feature_flags_enabled_idx").on(t.enabled),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    data: jsonb("data"),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId),
    index("notifications_user_read_idx").on(t.userId, t.read),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id),
    planId: text("plan_id").notNull(),
    planName: text("plan_name").notNull(),
    status: text("status").notNull().default("TRIAL"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("subscriptions_user_idx").on(t.userId)],
);

export const usageMetering = pgTable(
  "usage_metering",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id),
    metric: text("metric").notNull(),
    amount: integer("amount").notNull().default(0),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_metering_user_metric_idx").on(t.userId, t.metric),
    index("usage_metering_org_metric_idx").on(t.organizationId, t.metric),
  ],
);
