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
} from "drizzle-orm/pg-core";

export const accountStatusEnum = pgEnum("account_status", [
  "ACTIVE",
  "PENDING_VERIFICATION",
  "SUSPENDED",
  "DISABLED",
  "DELETION_PENDING",
]);

export const roleEnum = pgEnum("role_name", [
  "USER",
  "SUPPORT",
  "ADMIN",
  "SUPER_ADMIN",
]);

export const platformStatusEnum = pgEnum("platform_status", [
  "CONNECTED",
  "DISCONNECTED",
  "AUTHENTICATION_EXPIRED",
  "PERMISSION_MISSING",
  "RATE_LIMITED",
  "CONFIGURATION_UNAVAILABLE",
  "HEALTHY",
  "DEGRADED",
  "DEMO",
]);

export const evidenceKindEnum = pgEnum("evidence_kind", [
  "OBSERVED",
  "USER_PROVIDED",
  "DERIVED",
  "INFERRED",
]);

export const reasoningTierEnum = pgEnum("reasoning_tier", [
  "TIER_0_UTILITY",
  "TIER_1_EVERYDAY",
  "TIER_2_ADVANCED",
  "TIER_3_DEEP_INTELLIGENCE",
  "TIER_4_CRITICAL",
]);

export const lifecycleStageEnum = pgEnum("model_lifecycle_stage", [
  "DISCOVERED",
  "PROBING",
  "VALIDATED",
  "ACTIVE",
  "DEPRECATED",
  "RETIRED",
  "QUARANTINED",
]);

export const connectorStatusEnum = pgEnum("connector_status", [
  "AVAILABLE",
  "CONFIGURATION_REQUIRED",
  "PERMISSION_REQUIRED",
  "APP_REVIEW_REQUIRED",
  "UNAVAILABLE",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "RETRYING",
  "CANCELLED",
]);

export const supportTicketStatusEnum = pgEnum("support_ticket_status", [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_FOR_USER",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
]);

export const supportPriorityEnum = pgEnum("support_priority", [
  "LOW",
  "MEDIUM",
  "HIGH",
  "URGENT",
]);

export const notificationTypeEnum = pgEnum("notification_type", [
  "HIGH_VALUE_OPPORTUNITY",
  "RELATIONSHIP_COOLING",
  "NEW_MODEL_AVAILABLE",
  "PLATFORM_CONNECTION_PROBLEM",
  "PROVIDER_FAILURE",
  "TREND_ALERT",
  "SUPPORT_TICKET_UPDATE",
  "SECURITY_EVENT",
]);

export const featureFlagScopeEnum = pgEnum("feature_flag_scope", [
  "GLOBAL",
  "ENVIRONMENT",
  "ORGANIZATION",
  "USER",
]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "TRIAL",
  "ACTIVE",
  "PAST_DUE",
  "CANCELLED",
  "EXPIRED",
]);
