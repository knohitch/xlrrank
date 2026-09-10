ALTER TABLE "social_account_handles"
  ADD COLUMN IF NOT EXISTS "provider_data_category" text;

ALTER TABLE "social_account_handles"
  ADD COLUMN IF NOT EXISTS "provider_retention_basis" text;

CREATE INDEX IF NOT EXISTS "social_account_handles_provider_category_idx"
  ON "social_account_handles" USING btree ("provider_data_category", "last_seen_at");

CREATE TABLE IF NOT EXISTS "provider_retention_sweep_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_family" text NOT NULL,
  "window_start" timestamptz NOT NULL,
  "claimed_by" text NOT NULL,
  "claimed_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "status" text NOT NULL DEFAULT 'RUNNING',
  "metadata" jsonb,
  CONSTRAINT "provider_retention_claim_provider_check" CHECK (length("provider_family") > 0),
  CONSTRAINT "provider_retention_claim_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'FAILED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "provider_retention_sweep_claim_window_unique"
  ON "provider_retention_sweep_claims" USING btree ("provider_family", "window_start");

CREATE INDEX IF NOT EXISTS "provider_retention_sweep_claim_status_idx"
  ON "provider_retention_sweep_claims" USING btree ("status", "claimed_at");
