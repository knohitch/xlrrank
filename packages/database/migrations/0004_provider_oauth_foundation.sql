DO $$ BEGIN
  ALTER TYPE "public"."connector_status" ADD VALUE IF NOT EXISTS 'ACCESS_TIER_REQUIRED';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "provider_app_configurations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "platform_id" uuid NOT NULL,
  "environment" text DEFAULT 'production' NOT NULL,
  "client_id" text NOT NULL,
  "client_secret_encrypted" text,
  "redirect_uri" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_app_configurations_client_id_check" CHECK (length("client_id") > 0),
  CONSTRAINT "provider_app_configurations_redirect_uri_check" CHECK (length("redirect_uri") > 0),
  CONSTRAINT "provider_app_configurations_metadata_object_check"
    CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object')
);
DO $$ BEGIN
  ALTER TABLE "provider_app_configurations" ADD CONSTRAINT "provider_app_configurations_platform_id_platforms_id_fk"
    FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "provider_app_configurations_platform_environment_unique"
  ON "provider_app_configurations" USING btree ("platform_id", "environment");
CREATE INDEX IF NOT EXISTS "provider_app_configurations_platform_idx"
  ON "provider_app_configurations" USING btree ("platform_id");

CREATE TABLE IF NOT EXISTS "oauth_authorization_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "platform_id" uuid NOT NULL,
  "scope_id" uuid NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "state_digest" text NOT NULL,
  "pkce_verifier" text NOT NULL,
  "requested_scopes" jsonb NOT NULL,
  "redirect_to" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "metadata" jsonb,
  CONSTRAINT "oauth_authorization_transactions_state_digest_check" CHECK (length("state_digest") >= 32),
  CONSTRAINT "oauth_authorization_transactions_pkce_verifier_check" CHECK (length("pkce_verifier") >= 43),
  CONSTRAINT "oauth_authorization_transactions_requested_scopes_array_check"
    CHECK (jsonb_typeof("requested_scopes") = 'array'),
  CONSTRAINT "oauth_authorization_transactions_redirect_to_check" CHECK (length("redirect_to") > 0),
  CONSTRAINT "oauth_authorization_transactions_metadata_object_check"
    CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object')
);
DO $$ BEGIN
  ALTER TABLE "oauth_authorization_transactions" ADD CONSTRAINT "oauth_authorization_transactions_platform_id_platforms_id_fk"
    FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "oauth_authorization_transactions" ADD CONSTRAINT "oauth_authorization_transactions_scope_id_data_scopes_id_fk"
    FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "oauth_authorization_transactions" ADD CONSTRAINT "oauth_authorization_transactions_actor_user_id_users_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_authorization_transactions_state_unique"
  ON "oauth_authorization_transactions" USING btree ("state_digest");
CREATE INDEX IF NOT EXISTS "oauth_authorization_transactions_actor_idx"
  ON "oauth_authorization_transactions" USING btree ("actor_user_id");
CREATE INDEX IF NOT EXISTS "oauth_authorization_transactions_expires_idx"
  ON "oauth_authorization_transactions" USING btree ("expires_at");
