CREATE TABLE IF NOT EXISTS "provider_authorizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_family" text NOT NULL,
  "scope_id" uuid NOT NULL,
  "platform_id" uuid,
  "actor_user_id" uuid,
  "provider_user_id" text NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "credentials_encrypted" text,
  "credential_version" integer DEFAULT 1 NOT NULL,
  "granted_scopes" jsonb NOT NULL,
  "expires_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_authorizations_family_check" CHECK (length("provider_family") > 0),
  CONSTRAINT "provider_authorizations_user_check" CHECK (length("provider_user_id") > 0),
  CONSTRAINT "provider_authorizations_scopes_array_check" CHECK (jsonb_typeof("granted_scopes") = 'array'),
  CONSTRAINT "provider_authorizations_metadata_object_check"
    CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object')
);
DO $$ BEGIN
  ALTER TABLE "provider_authorizations" ADD CONSTRAINT "provider_authorizations_scope_id_data_scopes_id_fk"
    FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "provider_authorizations" ADD CONSTRAINT "provider_authorizations_platform_id_platforms_id_fk"
    FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "provider_authorizations" ADD CONSTRAINT "provider_authorizations_actor_user_id_users_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "provider_authorizations_scope_family_user_unique"
  ON "provider_authorizations" USING btree ("scope_id", "provider_family", "provider_user_id");
CREATE INDEX IF NOT EXISTS "provider_authorizations_scope_idx"
  ON "provider_authorizations" USING btree ("scope_id");
CREATE INDEX IF NOT EXISTS "provider_authorizations_family_idx"
  ON "provider_authorizations" USING btree ("provider_family");

CREATE TABLE IF NOT EXISTS "provider_authorization_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_authorization_id" uuid NOT NULL,
  "platform_id" uuid NOT NULL,
  "asset_type" text NOT NULL,
  "provider_asset_id" text NOT NULL,
  "parent_provider_asset_id" text,
  "name" text,
  "handle" text,
  "token_kind" text NOT NULL,
  "credentials_encrypted" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_authorization_assets_type_check" CHECK ("asset_type" IN ('FACEBOOK_PAGE', 'INSTAGRAM_PROFESSIONAL_ACCOUNT')),
  CONSTRAINT "provider_authorization_assets_asset_check" CHECK (length("provider_asset_id") > 0),
  CONSTRAINT "provider_authorization_assets_token_kind_check" CHECK ("token_kind" IN ('USER', 'PAGE')),
  CONSTRAINT "provider_authorization_assets_metadata_object_check"
    CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object')
);
DO $$ BEGIN
  ALTER TABLE "provider_authorization_assets" ADD CONSTRAINT "provider_authorization_assets_provider_authorization_id_fk"
    FOREIGN KEY ("provider_authorization_id") REFERENCES "public"."provider_authorizations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "provider_authorization_assets" ADD CONSTRAINT "provider_authorization_assets_platform_id_platforms_id_fk"
    FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "provider_authorization_assets_grant_platform_asset_unique"
  ON "provider_authorization_assets" USING btree ("provider_authorization_id", "platform_id", "provider_asset_id");
CREATE INDEX IF NOT EXISTS "provider_authorization_assets_platform_asset_idx"
  ON "provider_authorization_assets" USING btree ("platform_id", "provider_asset_id");
CREATE INDEX IF NOT EXISTS "provider_authorization_assets_parent_idx"
  ON "provider_authorization_assets" USING btree ("parent_provider_asset_id");

CREATE TABLE IF NOT EXISTS "webhook_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_family" text NOT NULL,
  "platform_id" uuid,
  "object_id" text,
  "dedupe_key" text NOT NULL,
  "signature_valid" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'RECEIVED' NOT NULL,
  "payload" jsonb NOT NULL,
  "metadata" jsonb,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  CONSTRAINT "webhook_receipts_family_check" CHECK (length("provider_family") > 0),
  CONSTRAINT "webhook_receipts_dedupe_check" CHECK (length("dedupe_key") > 0),
  CONSTRAINT "webhook_receipts_payload_object_check" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "webhook_receipts_metadata_object_check"
    CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object')
);
DO $$ BEGIN
  ALTER TABLE "webhook_receipts" ADD CONSTRAINT "webhook_receipts_platform_id_platforms_id_fk"
    FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_receipts_dedupe_unique"
  ON "webhook_receipts" USING btree ("provider_family", "dedupe_key");
CREATE INDEX IF NOT EXISTS "webhook_receipts_platform_idx"
  ON "webhook_receipts" USING btree ("platform_id");
CREATE INDEX IF NOT EXISTS "webhook_receipts_status_idx"
  ON "webhook_receipts" USING btree ("status");
