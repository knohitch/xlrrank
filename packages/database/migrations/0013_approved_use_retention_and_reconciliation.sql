ALTER TABLE "provider_data_retention_policies"
  DROP CONSTRAINT IF EXISTS "provider_data_retention_seconds_check";

ALTER TABLE "provider_data_retention_policies"
  ADD CONSTRAINT "provider_data_retention_seconds_check"
  CHECK (
    ("retention_mode" IN ('NO_PROVIDER_DURATION_LIMIT', 'APPROVED_USE_CASE') AND "max_retention_seconds" IS NULL)
    OR ("max_retention_seconds" > 0)
  );

UPDATE "provider_data_retention_policies"
SET "retention_class" = 'REDDIT_APPROVED_USE_PROFILE',
    "retention_mode" = 'APPROVED_USE_CASE',
    "max_retention_seconds" = NULL,
    "description" = 'Reddit authenticated user profile data is retained only as necessary for the approved configured use case; normal retention duration is resolved from provider/admin configuration or generic retention policy data.',
    "metadata" = jsonb_build_object(
      'source', 'REDDIT_RESPONSIBLE_BUILDER_POLICY_2026_06_05',
      'approvedUseCaseRequired', true,
      'deletionRequestDeadlineSeconds', 864000,
      'modelTrainingAllowed', false,
      'verifiedAt', '2026-09-10'
    ),
    "updated_at" = now()
WHERE "provider_family" = 'reddit' AND "data_category" = 'reddit_authenticated_user_profile';

UPDATE "provider_data_retention_policies"
SET "retention_class" = 'REDDIT_APPROVED_USE_PUBLIC_PROFILE',
    "retention_mode" = 'APPROVED_USE_CASE',
    "max_retention_seconds" = NULL,
    "description" = 'Reddit public user profile data fetched through the official Data API is retained only as necessary for the approved configured use case; normal retention duration is resolved from provider/admin configuration or generic retention policy data.',
    "metadata" = jsonb_build_object(
      'source', 'REDDIT_DATA_API_TERMS_2026_07_20',
      'approvedUseCaseRequired', true,
      'deletionRequestDeadlineSeconds', 864000,
      'modelTrainingAllowed', false,
      'verifiedAt', '2026-09-10'
    ),
    "updated_at" = now()
WHERE "provider_family" = 'reddit' AND "data_category" = 'reddit_public_user_profile';

UPDATE "provider_data_retention_policies"
SET "retention_class" = 'REDDIT_APPROVED_USE_CONTENT',
    "retention_mode" = 'APPROVED_USE_CASE',
    "max_retention_seconds" = NULL,
    "description" = 'Reddit user content fetched through the official Data API is retained only while required for the approved use case; normal retention duration is resolved from provider/admin configuration or generic retention policy data. Deleted/removed items are minimized at ingestion and reconciled periodically.',
    "metadata" = jsonb_build_object(
      'source', 'REDDIT_DATA_API_TERMS_2026_07_20',
      'approvedUseCaseRequired', true,
      'deletionRequestDeadlineSeconds', 864000,
      'modelTrainingAllowed', false,
      'verifiedAt', '2026-09-10'
    ),
    "updated_at" = now()
WHERE "provider_family" = 'reddit' AND "data_category" = 'reddit_user_content';

UPDATE "provider_data_retention_policies"
SET "retention_class" = 'REDDIT_APPROVED_USE_COMMENT',
    "retention_mode" = 'APPROVED_USE_CASE',
    "max_retention_seconds" = NULL,
    "description" = 'Reddit comments fetched through the official Data API are retained only while required for the approved use case; normal retention duration is resolved from provider/admin configuration or generic retention policy data. Deleted/removed items are minimized at ingestion and reconciled periodically.',
    "metadata" = jsonb_build_object(
      'source', 'REDDIT_DATA_API_TERMS_2026_07_20',
      'approvedUseCaseRequired', true,
      'deletionRequestDeadlineSeconds', 864000,
      'modelTrainingAllowed', false,
      'verifiedAt', '2026-09-10'
    ),
    "updated_at" = now()
WHERE "provider_family" = 'reddit' AND "data_category" = 'reddit_comment';

CREATE TABLE IF NOT EXISTS "provider_data_deletion_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_family" text NOT NULL,
  "scope_id" uuid REFERENCES "data_scopes"("id") ON DELETE SET NULL,
  "connection_id" uuid REFERENCES "social_connections"("id") ON DELETE SET NULL,
  "provider_authorization_id" uuid REFERENCES "provider_authorizations"("id") ON DELETE SET NULL,
  "reason" text NOT NULL,
  "source" text NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deadline_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING_DISPATCH',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "claimed_by" text,
  "claimed_at" timestamp with time zone,
  "lease_expires_at" timestamp with time zone,
  "failure_evidence" jsonb,
  "completed_at" timestamp with time zone,
  "completion_evidence" jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "provider_data_deletion_family_status_idx"
  ON "provider_data_deletion_requests" ("provider_family", "status");
CREATE INDEX IF NOT EXISTS "provider_data_deletion_scope_idx"
  ON "provider_data_deletion_requests" ("scope_id");

CREATE TABLE IF NOT EXISTS "provider_authorization_cleanups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "connection_id" uuid REFERENCES "social_connections"("id") ON DELETE SET NULL,
  "scope_id" uuid NOT NULL REFERENCES "data_scopes"("id") ON DELETE CASCADE,
  "platform_id" uuid NOT NULL REFERENCES "platforms"("id") ON DELETE CASCADE,
  "provider_family" text NOT NULL,
  "credentials_encrypted" text,
  "status" text NOT NULL DEFAULT 'PENDING',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "last_error" jsonb,
  "completed_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "provider_auth_cleanup_status_idx"
  ON "provider_authorization_cleanups" ("status");
CREATE INDEX IF NOT EXISTS "provider_auth_cleanup_family_idx"
  ON "provider_authorization_cleanups" ("provider_family");

CREATE TABLE IF NOT EXISTS "provider_reconciliation_checkpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "connection_id" uuid NOT NULL REFERENCES "social_connections"("id") ON DELETE CASCADE,
  "scope_id" uuid NOT NULL REFERENCES "data_scopes"("id") ON DELETE CASCADE,
  "provider_family" text NOT NULL,
  "entity_type" text NOT NULL,
  "last_processed_id" uuid,
  "last_reconciled_at" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'IDLE',
  "claimed_by" text,
  "claimed_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_reconciliation_conn_entity_unique" UNIQUE ("connection_id", "entity_type")
);

CREATE INDEX IF NOT EXISTS "provider_reconciliation_family_idx"
  ON "provider_reconciliation_checkpoints" ("provider_family", "status");
