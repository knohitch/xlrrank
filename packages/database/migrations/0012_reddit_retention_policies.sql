ALTER TYPE "connector_status" ADD VALUE IF NOT EXISTS 'ACCESS_REQUIRED';

INSERT INTO "provider_data_retention_policies" (
  "provider_family", "data_category", "retention_class", "retention_mode", "max_retention_seconds", "description", "metadata"
)
VALUES
  ('reddit', 'reddit_authenticated_user_profile', 'REDDIT_APPROVED_USE_PROFILE_30D_DEFAULT', 'FIXED_MAX_AGE', 2592000, 'Reddit authenticated user profile data is retained only for the approved configured use case; default local maximum is 30 days absent a stricter configured use case.', '{"source":"REDDIT_RESPONSIBLE_BUILDER_POLICY_2026_06_05","verifiedAt":"2026-09-10","modelTrainingAllowed":false}'::jsonb),
  ('reddit', 'reddit_public_user_profile', 'REDDIT_APPROVED_USE_PUBLIC_PROFILE_30D_DEFAULT', 'FIXED_MAX_AGE', 2592000, 'Reddit public user profile data fetched through the official Data API is retained only for the approved configured use case; default local maximum is 30 days.', '{"source":"REDDIT_DATA_API_TERMS_2026_07_20","verifiedAt":"2026-09-10","modelTrainingAllowed":false}'::jsonb),
  ('reddit', 'reddit_user_content', 'REDDIT_APPROVED_USE_CONTENT_30D_DEFAULT', 'FIXED_MAX_AGE', 2592000, 'Reddit user content fetched through the official Data API is retained only while required for the approved use case; default local maximum is 30 days and deleted/removed placeholders are minimized at ingestion.', '{"source":"REDDIT_DATA_API_TERMS_2026_07_20","verifiedAt":"2026-09-10","modelTrainingAllowed":false}'::jsonb),
  ('reddit', 'reddit_comment', 'REDDIT_APPROVED_USE_COMMENT_30D_DEFAULT', 'FIXED_MAX_AGE', 2592000, 'Reddit comments fetched through the official Data API are retained only while required for the approved use case; default local maximum is 30 days and deleted/removed placeholders are minimized at ingestion.', '{"source":"REDDIT_DATA_API_TERMS_2026_07_20","verifiedAt":"2026-09-10","modelTrainingAllowed":false}'::jsonb)
ON CONFLICT ("provider_family", "data_category") DO UPDATE SET
  "retention_class" = EXCLUDED."retention_class",
  "retention_mode" = EXCLUDED."retention_mode",
  "max_retention_seconds" = EXCLUDED."max_retention_seconds",
  "description" = EXCLUDED."description",
  "metadata" = EXCLUDED."metadata",
  "updated_at" = now();
