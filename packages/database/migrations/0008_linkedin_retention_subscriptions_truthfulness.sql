ALTER TABLE "provider_data_retention_policies"
  ADD COLUMN IF NOT EXISTS "retention_mode" text NOT NULL DEFAULT 'FIXED_MAX_AGE';

ALTER TABLE "provider_data_retention_policies"
  ALTER COLUMN "max_retention_seconds" DROP NOT NULL;

ALTER TABLE "provider_data_retention_policies"
  DROP CONSTRAINT IF EXISTS "provider_data_retention_seconds_check";

ALTER TABLE "provider_data_retention_policies"
  ADD CONSTRAINT "provider_data_retention_seconds_check"
  CHECK (
    ("retention_mode" = 'NO_PROVIDER_DURATION_LIMIT' AND "max_retention_seconds" IS NULL)
    OR ("retention_mode" <> 'NO_PROVIDER_DURATION_LIMIT' AND "max_retention_seconds" > 0)
  );

ALTER TABLE "social_external_accounts"
  ADD COLUMN IF NOT EXISTS "provider_data_category" text;
ALTER TABLE "social_account_observations"
  ADD COLUMN IF NOT EXISTS "provider_data_category" text;
ALTER TABLE "social_content_items"
  ADD COLUMN IF NOT EXISTS "provider_data_category" text;
ALTER TABLE "social_content_observations"
  ADD COLUMN IF NOT EXISTS "provider_data_category" text;
ALTER TABLE "social_interactions"
  ADD COLUMN IF NOT EXISTS "provider_data_category" text;
ALTER TABLE "social_interaction_observations"
  ADD COLUMN IF NOT EXISTS "provider_data_category" text;
ALTER TABLE "social_content_metrics"
  ADD COLUMN IF NOT EXISTS "provider_data_category" text;
ALTER TABLE "webhook_receipts"
  ADD COLUMN IF NOT EXISTS "provider_data_category" text;

CREATE INDEX IF NOT EXISTS "social_account_observations_provider_category_idx"
  ON "social_account_observations" USING btree ("provider_data_category", "observed_at");
CREATE INDEX IF NOT EXISTS "social_content_observations_provider_category_idx"
  ON "social_content_observations" USING btree ("provider_data_category", "provider_created_at", "observed_at");
CREATE INDEX IF NOT EXISTS "social_interaction_observations_provider_category_idx"
  ON "social_interaction_observations" USING btree ("provider_data_category", "observed_at");
CREATE INDEX IF NOT EXISTS "social_content_metrics_provider_category_idx"
  ON "social_content_metrics" USING btree ("provider_data_category", "collected_at");
CREATE INDEX IF NOT EXISTS "webhook_receipts_provider_category_idx"
  ON "webhook_receipts" USING btree ("provider_family", "provider_data_category", "received_at");

CREATE TABLE IF NOT EXISTS "provider_event_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_family" text NOT NULL,
  "scope_id" uuid NOT NULL,
  "platform_id" uuid NOT NULL,
  "provider_authorization_id" uuid NOT NULL,
  "provider_authorization_asset_id" uuid NOT NULL,
  "social_connection_id" uuid NOT NULL,
  "provider_user_id" text NOT NULL,
  "provider_asset_id" text NOT NULL,
  "developer_application_urn" text NOT NULL,
  "member_urn" text NOT NULL,
  "entity_urn" text NOT NULL,
  "event_type" text NOT NULL,
  "webhook_url" text NOT NULL,
  "provider_status" text NOT NULL,
  "last_provider_sync_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "deactivated_at" timestamp with time zone,
  "last_error" jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_event_subscriptions_family_check" CHECK (length("provider_family") > 0),
  CONSTRAINT "provider_event_subscriptions_user_check" CHECK (length("provider_user_id") > 0),
  CONSTRAINT "provider_event_subscriptions_asset_check" CHECK (length("provider_asset_id") > 0),
  CONSTRAINT "provider_event_subscriptions_event_check" CHECK (length("event_type") > 0),
  CONSTRAINT "provider_event_subscriptions_metadata_object_check"
    CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object'),
  CONSTRAINT "provider_event_subscriptions_error_object_check"
    CHECK ("last_error" IS NULL OR jsonb_typeof("last_error") = 'object')
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_event_subscriptions_scope_id_data_scopes_id_fk'
  ) THEN
    ALTER TABLE "provider_event_subscriptions"
      ADD CONSTRAINT "provider_event_subscriptions_scope_id_data_scopes_id_fk"
      FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_event_subscriptions_platform_id_platforms_id_fk'
  ) THEN
    ALTER TABLE "provider_event_subscriptions"
      ADD CONSTRAINT "provider_event_subscriptions_platform_id_platforms_id_fk"
      FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE restrict;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_event_subscriptions_authorization_id_fk'
  ) THEN
    ALTER TABLE "provider_event_subscriptions"
      ADD CONSTRAINT "provider_event_subscriptions_authorization_id_fk"
      FOREIGN KEY ("provider_authorization_id") REFERENCES "public"."provider_authorizations"("id") ON DELETE cascade;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_event_subscriptions_asset_id_fk'
  ) THEN
    ALTER TABLE "provider_event_subscriptions"
      ADD CONSTRAINT "provider_event_subscriptions_asset_id_fk"
      FOREIGN KEY ("provider_authorization_asset_id") REFERENCES "public"."provider_authorization_assets"("id") ON DELETE cascade;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_event_subscriptions_connection_id_fk'
  ) THEN
    ALTER TABLE "provider_event_subscriptions"
      ADD CONSTRAINT "provider_event_subscriptions_connection_id_fk"
      FOREIGN KEY ("social_connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "provider_event_subscription_unique"
  ON "provider_event_subscriptions" USING btree (
    "provider_family", "provider_authorization_id", "provider_authorization_asset_id", "event_type"
  );
CREATE INDEX IF NOT EXISTS "provider_event_subscription_connection_idx"
  ON "provider_event_subscriptions" USING btree ("social_connection_id");
CREATE INDEX IF NOT EXISTS "provider_event_subscription_asset_idx"
  ON "provider_event_subscriptions" USING btree ("provider_authorization_asset_id");
CREATE INDEX IF NOT EXISTS "provider_event_subscription_status_idx"
  ON "provider_event_subscriptions" USING btree ("provider_status");

INSERT INTO "provider_data_retention_policies" (
  "provider_family", "data_category", "retention_class", "retention_mode",
  "max_retention_seconds", "description", "metadata"
) VALUES
  ('linkedin', 'authenticated_member_id', 'LINKEDIN_AUTHENTICATED_MEMBER_ID', 'NO_PROVIDER_DURATION_LIMIT', NULL, 'LinkedIn authenticated member Person ID / URN has no provider duration restriction; consent, deletion, and revocation duties still apply.', '{"source":"LINKEDIN_MARKETING_API_DATA_STORAGE_REQUIREMENTS_2026_08"}'::jsonb),
  ('linkedin', 'authenticated_member_profile', 'LINKEDIN_AUTHENTICATED_MEMBER_PROFILE', 'NO_PROVIDER_DURATION_LIMIT', NULL, 'LinkedIn authenticated member profile data has no provider duration restriction; consent, deletion, and revocation duties still apply.', '{"source":"LINKEDIN_MARKETING_API_DATA_STORAGE_REQUIREMENTS_2026_08"}'::jsonb),
  ('linkedin', 'other_member_id', 'LINKEDIN_OTHER_MEMBER_ID', 'NO_PROVIDER_DURATION_LIMIT', NULL, 'LinkedIn other member Person ID / URN has no provider duration restriction.', '{"source":"LINKEDIN_MARKETING_API_DATA_STORAGE_REQUIREMENTS_2026_08"}'::jsonb),
  ('linkedin', 'other_member_profile', 'LINKEDIN_OTHER_MEMBER_PROFILE_CACHE_24H', 'CACHE_ONLY', 86400, 'LinkedIn other member profile data is cache-only for 24 hours.', '{"source":"LINKEDIN_MARKETING_API_DATA_STORAGE_REQUIREMENTS_2026_08"}'::jsonb),
  ('linkedin', 'linkedin_activity_identifiers', 'LINKEDIN_ACTIVITY_IDENTIFIERS', 'NO_PROVIDER_DURATION_LIMIT', NULL, 'LinkedIn IDs and URNs associated with managing advertising and organization activity have no provider duration restriction.', '{"source":"LINKEDIN_MARKETING_API_DATA_STORAGE_REQUIREMENTS_2026_08"}'::jsonb),
  ('linkedin', 'member_social_activity', 'LINKEDIN_MEMBER_SOCIAL_ACTIVITY_48H', 'FIXED_MAX_AGE', 172800, 'LinkedIn member social activity data may be stored for 48 hours.', '{"source":"LINKEDIN_MARKETING_API_DATA_STORAGE_REQUIREMENTS_2026_08"}'::jsonb),
  ('linkedin', 'organization_social_activity', 'LINKEDIN_ORGANIZATION_SOCIAL_ACTIVITY_6W', 'FIXED_MAX_AGE', 3628800, 'LinkedIn organization social activity data may be stored for six weeks unless the authenticated-organization condition applies.', '{"source":"LINKEDIN_MARKETING_API_DATA_STORAGE_REQUIREMENTS_2026_08"}'::jsonb),
  ('linkedin', 'organization_social_activity_authenticated_org', 'LINKEDIN_ORGANIZATION_SOCIAL_ACTIVITY_AUTH_ORG_6M', 'FIXED_MAX_AGE', 15552000, 'LinkedIn organization social activity relating to an organization authenticated into the application may be stored for six months.', '{"source":"LINKEDIN_MARKETING_API_DATA_STORAGE_REQUIREMENTS_2026_08","condition":"AUTHENTICATED_ORGANIZATION_ASSET"}'::jsonb),
  ('linkedin', 'organization_profile', 'LINKEDIN_ORGANIZATION_PROFILE_AUTH_ORG_8W', 'FIXED_MAX_AGE', 4838400, 'LinkedIn organization profile data for an organization authenticated into the application may be stored for eight weeks.', '{"source":"LINKEDIN_MARKETING_API_DATA_STORAGE_REQUIREMENTS_2026_08","condition":"AUTHENTICATED_ORGANIZATION_ASSET"}'::jsonb),
  ('linkedin', 'organization_profile_limited', 'LINKEDIN_ORGANIZATION_PROFILE_LIMITED_30D', 'CACHE_ONLY', 2592000, 'LinkedIn non-authenticated organization profile storage is limited to organization name and logo URL for 30 days.', '{"source":"LINKEDIN_MARKETING_API_DATA_STORAGE_REQUIREMENTS_2026_08"}'::jsonb),
  ('linkedin', 'organization_admin_reporting', 'LINKEDIN_ORGANIZATION_ADMIN_REPORTING_1Y', 'FIXED_MAX_AGE', 31536000, 'LinkedIn Organization Pages admin and reporting data may be stored for one year and excludes individual member-level data.', '{"source":"LINKEDIN_MARKETING_API_DATA_STORAGE_REQUIREMENTS_2026_08"}'::jsonb),
  ('linkedin', 'webhook_operational_receipt', 'XLRRANK_OPERATIONAL_RETENTION_7D', 'XLRRANK_OPERATIONAL_RETENTION', 604800, 'XLRrank minimal structured webhook receipts are operational records, not a LinkedIn-mandated retention category.', '{"source":"XLRRANK_OPERATIONAL_RETENTION"}'::jsonb)
ON CONFLICT ("provider_family", "data_category") DO UPDATE SET
  "retention_class" = EXCLUDED."retention_class",
  "retention_mode" = EXCLUDED."retention_mode",
  "max_retention_seconds" = EXCLUDED."max_retention_seconds",
  "description" = EXCLUDED."description",
  "metadata" = EXCLUDED."metadata",
  "updated_at" = now();

UPDATE "provider_data_retention_policies"
SET "retention_class" = 'SUPERSEDED_BY_0008',
    "retention_mode" = 'XLRRANK_OPERATIONAL_RETENTION',
    "max_retention_seconds" = 1,
    "description" = 'Superseded by Sprint 08 closure migration 0008; do not use for LinkedIn classification.'
WHERE "provider_family" = 'linkedin'
  AND "data_category" IN (
    'member_profile',
    'member_content',
    'organization_content',
    'organization_analytics',
    'webhook_receipt'
  );
