ALTER TABLE "platforms"
  ADD COLUMN IF NOT EXISTS "provider_family" text;

UPDATE "platforms"
SET "provider_family" = COALESCE("provider_family", "slug")
WHERE "provider_family" IS NULL;

UPDATE "platforms"
SET "provider_family" = 'meta'
WHERE "slug" IN ('facebook', 'instagram');

CREATE INDEX IF NOT EXISTS "platforms_provider_family_idx"
  ON "platforms" USING btree ("provider_family");

ALTER TABLE "provider_event_subscriptions"
  ADD COLUMN IF NOT EXISTS "provider_key" jsonb;

UPDATE "provider_event_subscriptions"
SET "provider_key" = COALESCE(
  "provider_key",
  jsonb_build_object(
    'applicationKey', "developer_application_urn",
    'actorKey', "member_urn",
    'entityKey', "entity_urn",
    'eventType', "event_type"
  )
)
WHERE "provider_key" IS NULL;

ALTER TABLE "provider_event_subscriptions"
  DROP CONSTRAINT IF EXISTS "provider_event_subscriptions_provider_key_object_check";

ALTER TABLE "provider_event_subscriptions"
  ADD CONSTRAINT "provider_event_subscriptions_provider_key_object_check"
  CHECK ("provider_key" IS NULL OR jsonb_typeof("provider_key") = 'object');
