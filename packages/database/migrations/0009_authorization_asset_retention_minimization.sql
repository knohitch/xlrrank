ALTER TABLE "provider_authorization_assets"
  ADD COLUMN IF NOT EXISTS "provider_data_category" text;

CREATE INDEX IF NOT EXISTS "provider_authorization_assets_provider_category_idx"
  ON "provider_authorization_assets" USING btree ("provider_data_category", "updated_at");
