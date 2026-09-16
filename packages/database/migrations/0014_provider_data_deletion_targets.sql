CREATE TABLE IF NOT EXISTS "provider_data_deletion_targets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "deletion_request_id" uuid NOT NULL REFERENCES "provider_data_deletion_requests"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_data_deletion_targets_entity_type_check"
    CHECK ("entity_type" IN ('CONTENT_ITEM', 'INTERACTION', 'EXTERNAL_ACCOUNT')),
  CONSTRAINT "provider_data_deletion_targets_status_check"
    CHECK ("status" IN ('PENDING', 'PURGED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "provider_data_deletion_targets_request_entity_unique"
  ON "provider_data_deletion_targets" ("deletion_request_id", "entity_type", "entity_id");

CREATE INDEX IF NOT EXISTS "provider_data_deletion_targets_claim_idx"
  ON "provider_data_deletion_targets" ("deletion_request_id", "entity_type", "status", "entity_id");

CREATE INDEX IF NOT EXISTS "provider_data_deletion_targets_entity_idx"
  ON "provider_data_deletion_targets" ("entity_type", "entity_id");
