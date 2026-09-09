CREATE TABLE IF NOT EXISTS "provider_data_retention_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_family" text NOT NULL,
  "data_category" text NOT NULL,
  "retention_class" text NOT NULL,
  "max_retention_seconds" integer NOT NULL,
  "description" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_data_retention_family_check" CHECK (length("provider_family") > 0),
  CONSTRAINT "provider_data_retention_category_check" CHECK (length("data_category") > 0),
  CONSTRAINT "provider_data_retention_seconds_check" CHECK ("max_retention_seconds" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "provider_retention_family_category_unique"
  ON "provider_data_retention_policies" USING btree ("provider_family", "data_category");

CREATE INDEX IF NOT EXISTS "provider_retention_family_idx"
  ON "provider_data_retention_policies" USING btree ("provider_family");

INSERT INTO "provider_data_retention_policies" (
  "provider_family", "data_category", "retention_class", "max_retention_seconds", "description"
) VALUES
  ('linkedin', 'member_profile', 'TRANSIENT_24H', 86400, 'Member profile data must not be stored longer than 24 hours per LinkedIn Marketing API terms'),
  ('linkedin', 'member_content', 'TRANSIENT_24H', 86400, 'Member content must not be stored longer than 24 hours per LinkedIn Marketing API terms'),
  ('linkedin', 'organization_profile', 'ORGANIZATION_PROFILE_56D', 4838400, 'Organization profile data for authenticated organizations up to 8 weeks (56 days)'),
  ('linkedin', 'organization_content', 'ORGANIZATION_CONTENT_56D', 4838400, 'Organization organic posts and comments up to 8 weeks (56 days)'),
  ('linkedin', 'organization_analytics', 'ANALYTICS_30D', 2592000, 'Organization follower and share analytics up to 30 days'),
  ('linkedin', 'webhook_receipt', 'WEBHOOK_RECEIPT_7D', 604800, 'Webhook receipt payloads transient storage up to 7 days')
ON CONFLICT ("provider_family", "data_category") DO UPDATE SET
  "retention_class" = EXCLUDED."retention_class",
  "max_retention_seconds" = EXCLUDED."max_retention_seconds",
  "description" = EXCLUDED."description",
  "updated_at" = now();

ALTER TABLE "provider_authorization_assets"
  DROP CONSTRAINT IF EXISTS "provider_authorization_assets_type_check";

ALTER TABLE "provider_authorization_assets"
  ADD CONSTRAINT "provider_authorization_assets_type_check"
  CHECK ("asset_type" IN ('FACEBOOK_PAGE', 'INSTAGRAM_PROFESSIONAL_ACCOUNT', 'LINKEDIN_ORGANIZATION'));
