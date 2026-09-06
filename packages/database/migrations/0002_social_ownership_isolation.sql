CREATE TABLE "data_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" text NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_scopes_type_check" CHECK ("scope_type" IN ('PERSONAL', 'ORGANIZATION')),
	CONSTRAINT "data_scopes_owner_check" CHECK (
		("scope_type" = 'PERSONAL' AND "user_id" IS NOT NULL AND "organization_id" IS NULL)
		OR ("scope_type" = 'ORGANIZATION' AND "organization_id" IS NOT NULL AND "user_id" IS NULL)
	)
);
--> statement-breakpoint
ALTER TABLE "data_scopes" ADD CONSTRAINT "data_scopes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "data_scopes" ADD CONSTRAINT "data_scopes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "data_scopes_personal_user_unique" ON "data_scopes" USING btree ("user_id") WHERE "scope_type" = 'PERSONAL';
--> statement-breakpoint
CREATE UNIQUE INDEX "data_scopes_org_unique" ON "data_scopes" USING btree ("organization_id") WHERE "scope_type" = 'ORGANIZATION';
--> statement-breakpoint
CREATE INDEX "data_scopes_type_idx" ON "data_scopes" USING btree ("scope_type");
--> statement-breakpoint
CREATE TABLE "organization_member_permissions" (
	"member_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_member_permissions_member_id_capability_pk" PRIMARY KEY("member_id","capability"),
	CONSTRAINT "org_member_permissions_capability_check" CHECK ("capability" IN ('VIEW_SOCIAL_DATA', 'MANAGE_SOCIAL_CONNECTIONS', 'TRIGGER_SOCIAL_SYNC', 'MANAGE_ORGANIZATION'))
);
--> statement-breakpoint
ALTER TABLE "organization_member_permissions" ADD CONSTRAINT "organization_member_permissions_member_id_organization_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."organization_members"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "org_member_permissions_capability_idx" ON "organization_member_permissions" USING btree ("capability");
--> statement-breakpoint
CREATE TABLE "social_external_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"current_handle" text,
	"display_name" text,
	"profile_url" text,
	"profile_image_url" text,
	"bio" text,
	"location" text,
	"website" text,
	"follower_count" integer,
	"following_count" integer,
	"visibility" text DEFAULT 'UNKNOWN' NOT NULL,
	"metadata" jsonb,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_external_accounts_visibility_check" CHECK ("visibility" IN ('PUBLIC', 'SCOPE_PRIVATE', 'RESTRICTED', 'UNKNOWN'))
);
--> statement-breakpoint
ALTER TABLE "social_external_accounts" ADD CONSTRAINT "social_external_accounts_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "social_external_accounts_platform_external_unique" ON "social_external_accounts" USING btree ("platform_id","external_id");
--> statement-breakpoint
CREATE INDEX "social_external_accounts_platform_handle_idx" ON "social_external_accounts" USING btree ("platform_id","current_handle");
--> statement-breakpoint
CREATE INDEX "social_external_accounts_visibility_idx" ON "social_external_accounts" USING btree ("visibility");
--> statement-breakpoint
CREATE TABLE "social_account_handles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_account_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "social_account_handles" ADD CONSTRAINT "social_account_handles_external_account_id_social_external_accounts_id_fk" FOREIGN KEY ("external_account_id") REFERENCES "public"."social_external_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "social_account_handles_account_handle_unique" ON "social_account_handles" USING btree ("external_account_id","handle");
--> statement-breakpoint
CREATE INDEX "social_account_handles_handle_idx" ON "social_account_handles" USING btree ("handle");
--> statement-breakpoint
CREATE TABLE "social_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"platform_id" uuid NOT NULL,
	"external_account_id" uuid,
	"status" text DEFAULT 'DISCONNECTED' NOT NULL,
	"credentials_encrypted" text,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"verified_external_id" text,
	"verified_handle" text,
	"sync_cursor" text,
	"cursor_updated_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_sync_attempt_at" timestamp with time zone,
	"sync_error" jsonb,
	"rate_limit_remaining" integer,
	"rate_limit_reset_at" timestamp with time zone,
	"retry_after_seconds" integer,
	"provider_metadata" jsonb,
	"disabled_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_connections_status_check" CHECK ("status" IN ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'DEGRADED', 'REAUTH_REQUIRED', 'ERROR', 'DISABLED')),
	CONSTRAINT "social_connections_connected_credentials_check" CHECK ("status" <> 'CONNECTED' OR "credentials_encrypted" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_external_account_id_social_external_accounts_id_fk" FOREIGN KEY ("external_account_id") REFERENCES "public"."social_external_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "social_connections_scope_platform_unique" ON "social_connections" USING btree ("scope_id","platform_id");
--> statement-breakpoint
CREATE INDEX "social_connections_scope_idx" ON "social_connections" USING btree ("scope_id");
--> statement-breakpoint
CREATE INDEX "social_connections_platform_idx" ON "social_connections" USING btree ("platform_id");
--> statement-breakpoint
CREATE INDEX "social_connections_external_account_idx" ON "social_connections" USING btree ("external_account_id");
--> statement-breakpoint
CREATE INDEX "social_connections_status_idx" ON "social_connections" USING btree ("status");
--> statement-breakpoint
CREATE TABLE "social_ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"platform_id" uuid NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"cursor_before" text,
	"cursor_after" text,
	"profiles_processed" integer DEFAULT 0 NOT NULL,
	"content_processed" integer DEFAULT 0 NOT NULL,
	"interactions_processed" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"retry_classification" text,
	"normalization_version" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "social_ingestion_runs_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL')),
	CONSTRAINT "social_ingestion_runs_retry_check" CHECK ("retry_classification" IS NULL OR "retry_classification" IN ('RETRYABLE', 'NON_RETRYABLE', 'REAUTH_REQUIRED'))
);
--> statement-breakpoint
ALTER TABLE "social_ingestion_runs" ADD CONSTRAINT "social_ingestion_runs_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_ingestion_runs" ADD CONSTRAINT "social_ingestion_runs_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_ingestion_runs" ADD CONSTRAINT "social_ingestion_runs_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "social_ingestion_runs_connection_idx" ON "social_ingestion_runs" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX "social_ingestion_runs_scope_idx" ON "social_ingestion_runs" USING btree ("scope_id");
--> statement-breakpoint
CREATE INDEX "social_ingestion_runs_status_idx" ON "social_ingestion_runs" USING btree ("status");
--> statement-breakpoint
CREATE TABLE "social_account_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_account_id" uuid NOT NULL,
	"visibility" text DEFAULT 'UNKNOWN' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_created_at" timestamp with time zone,
	"normalization_version" text NOT NULL,
	"adapter_version" text NOT NULL,
	"ingestion_run_id" uuid,
	"metadata" jsonb,
	CONSTRAINT "social_account_observations_visibility_check" CHECK ("visibility" IN ('PUBLIC', 'SCOPE_PRIVATE', 'RESTRICTED', 'UNKNOWN'))
);
--> statement-breakpoint
ALTER TABLE "social_account_observations" ADD CONSTRAINT "social_account_observations_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_account_observations" ADD CONSTRAINT "social_account_observations_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_account_observations" ADD CONSTRAINT "social_account_observations_external_account_id_social_external_accounts_id_fk" FOREIGN KEY ("external_account_id") REFERENCES "public"."social_external_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_account_observations" ADD CONSTRAINT "social_account_observations_ingestion_run_id_social_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."social_ingestion_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "social_account_observations_scope_account_unique" ON "social_account_observations" USING btree ("scope_id","external_account_id");
--> statement-breakpoint
CREATE INDEX "social_account_observations_scope_idx" ON "social_account_observations" USING btree ("scope_id");
--> statement-breakpoint
CREATE INDEX "social_account_observations_connection_idx" ON "social_account_observations" USING btree ("connection_id");
--> statement-breakpoint
CREATE TABLE "social_content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid,
	"platform_id" uuid NOT NULL,
	"author_external_account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"body" text NOT NULL,
	"content_type" text,
	"language" text,
	"visibility" text DEFAULT 'UNKNOWN' NOT NULL,
	"provider_created_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_content_items_visibility_check" CHECK ("visibility" IN ('PUBLIC', 'SCOPE_PRIVATE', 'RESTRICTED', 'UNKNOWN')),
	CONSTRAINT "social_content_items_scope_visibility_check" CHECK (
		("visibility" = 'PUBLIC' AND "scope_id" IS NULL)
		OR ("visibility" IN ('SCOPE_PRIVATE', 'RESTRICTED', 'UNKNOWN') AND "scope_id" IS NOT NULL)
	)
);
--> statement-breakpoint
ALTER TABLE "social_content_items" ADD CONSTRAINT "social_content_items_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_content_items" ADD CONSTRAINT "social_content_items_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_content_items" ADD CONSTRAINT "social_content_items_author_external_account_id_social_external_accounts_id_fk" FOREIGN KEY ("author_external_account_id") REFERENCES "public"."social_external_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "social_content_public_identity_unique" ON "social_content_items" USING btree ("platform_id","external_id") WHERE "scope_id" IS NULL AND "visibility" = 'PUBLIC';
--> statement-breakpoint
CREATE UNIQUE INDEX "social_content_private_identity_unique" ON "social_content_items" USING btree ("scope_id","platform_id","external_id") WHERE "scope_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "social_content_items_scope_idx" ON "social_content_items" USING btree ("scope_id");
--> statement-breakpoint
CREATE INDEX "social_content_items_author_idx" ON "social_content_items" USING btree ("author_external_account_id");
--> statement-breakpoint
CREATE INDEX "social_content_items_visibility_idx" ON "social_content_items" USING btree ("visibility");
--> statement-breakpoint
CREATE TABLE "social_content_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"visibility" text DEFAULT 'UNKNOWN' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_created_at" timestamp with time zone,
	"normalization_version" text NOT NULL,
	"adapter_version" text NOT NULL,
	"ingestion_run_id" uuid,
	"metadata" jsonb,
	CONSTRAINT "social_content_observations_visibility_check" CHECK ("visibility" IN ('PUBLIC', 'SCOPE_PRIVATE', 'RESTRICTED', 'UNKNOWN'))
);
--> statement-breakpoint
ALTER TABLE "social_content_observations" ADD CONSTRAINT "social_content_observations_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_content_observations" ADD CONSTRAINT "social_content_observations_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_content_observations" ADD CONSTRAINT "social_content_observations_content_item_id_social_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."social_content_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_content_observations" ADD CONSTRAINT "social_content_observations_ingestion_run_id_social_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."social_ingestion_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "social_content_observations_scope_content_unique" ON "social_content_observations" USING btree ("scope_id","content_item_id");
--> statement-breakpoint
CREATE INDEX "social_content_observations_scope_idx" ON "social_content_observations" USING btree ("scope_id");
--> statement-breakpoint
CREATE INDEX "social_content_observations_connection_idx" ON "social_content_observations" USING btree ("connection_id");
--> statement-breakpoint
CREATE TABLE "social_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid,
	"platform_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"from_external_account_id" uuid NOT NULL,
	"to_content_item_id" uuid,
	"to_external_account_id" uuid,
	"type" text NOT NULL,
	"body" text,
	"visibility" text DEFAULT 'UNKNOWN' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_interactions_type_check" CHECK ("type" IN ('COMMENT', 'REPLY', 'MENTION', 'LIKE', 'REPOST', 'FOLLOW')),
	CONSTRAINT "social_interactions_visibility_check" CHECK ("visibility" IN ('PUBLIC', 'SCOPE_PRIVATE', 'RESTRICTED', 'UNKNOWN')),
	CONSTRAINT "social_interactions_scope_visibility_check" CHECK (
		("visibility" = 'PUBLIC' AND "scope_id" IS NULL)
		OR ("visibility" IN ('SCOPE_PRIVATE', 'RESTRICTED', 'UNKNOWN') AND "scope_id" IS NOT NULL)
	)
);
--> statement-breakpoint
ALTER TABLE "social_interactions" ADD CONSTRAINT "social_interactions_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_interactions" ADD CONSTRAINT "social_interactions_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_interactions" ADD CONSTRAINT "social_interactions_from_external_account_id_social_external_accounts_id_fk" FOREIGN KEY ("from_external_account_id") REFERENCES "public"."social_external_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_interactions" ADD CONSTRAINT "social_interactions_to_content_item_id_social_content_items_id_fk" FOREIGN KEY ("to_content_item_id") REFERENCES "public"."social_content_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_interactions" ADD CONSTRAINT "social_interactions_to_external_account_id_social_external_accounts_id_fk" FOREIGN KEY ("to_external_account_id") REFERENCES "public"."social_external_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "social_interactions_public_identity_unique" ON "social_interactions" USING btree ("platform_id","external_id") WHERE "scope_id" IS NULL AND "visibility" = 'PUBLIC';
--> statement-breakpoint
CREATE UNIQUE INDEX "social_interactions_private_identity_unique" ON "social_interactions" USING btree ("scope_id","platform_id","external_id") WHERE "scope_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "social_interactions_scope_idx" ON "social_interactions" USING btree ("scope_id");
--> statement-breakpoint
CREATE INDEX "social_interactions_from_idx" ON "social_interactions" USING btree ("from_external_account_id");
--> statement-breakpoint
CREATE INDEX "social_interactions_content_idx" ON "social_interactions" USING btree ("to_content_item_id");
--> statement-breakpoint
CREATE TABLE "social_interaction_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"visibility" text DEFAULT 'UNKNOWN' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"normalization_version" text NOT NULL,
	"adapter_version" text NOT NULL,
	"ingestion_run_id" uuid,
	"metadata" jsonb,
	CONSTRAINT "social_interaction_observations_visibility_check" CHECK ("visibility" IN ('PUBLIC', 'SCOPE_PRIVATE', 'RESTRICTED', 'UNKNOWN'))
);
--> statement-breakpoint
ALTER TABLE "social_interaction_observations" ADD CONSTRAINT "social_interaction_observations_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_interaction_observations" ADD CONSTRAINT "social_interaction_observations_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_interaction_observations" ADD CONSTRAINT "social_interaction_observations_interaction_id_social_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."social_interactions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_interaction_observations" ADD CONSTRAINT "social_interaction_observations_ingestion_run_id_social_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."social_ingestion_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "social_interaction_observations_scope_interaction_unique" ON "social_interaction_observations" USING btree ("scope_id","interaction_id");
--> statement-breakpoint
CREATE INDEX "social_interaction_observations_scope_idx" ON "social_interaction_observations" USING btree ("scope_id");
--> statement-breakpoint
CREATE INDEX "social_interaction_observations_connection_idx" ON "social_interaction_observations" USING btree ("connection_id");
--> statement-breakpoint
CREATE TABLE "social_content_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"ingestion_run_id" uuid,
	"snapshot_key" text NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"shares" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"engagement_rate" double precision,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_metadata" jsonb,
	CONSTRAINT "social_content_metrics_nonnegative_check" CHECK ("likes" >= 0 AND "comments" >= 0 AND "shares" >= 0 AND "impressions" >= 0)
);
--> statement-breakpoint
ALTER TABLE "social_content_metrics" ADD CONSTRAINT "social_content_metrics_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_content_metrics" ADD CONSTRAINT "social_content_metrics_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_content_metrics" ADD CONSTRAINT "social_content_metrics_content_item_id_social_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."social_content_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "social_content_metrics" ADD CONSTRAINT "social_content_metrics_ingestion_run_id_social_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."social_ingestion_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "social_content_metrics_snapshot_unique" ON "social_content_metrics" USING btree ("scope_id","content_item_id","snapshot_key");
--> statement-breakpoint
CREATE INDEX "social_content_metrics_content_idx" ON "social_content_metrics" USING btree ("content_item_id");
--> statement-breakpoint
CREATE INDEX "social_content_metrics_connection_idx" ON "social_content_metrics" USING btree ("connection_id");
--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "relationships_scope_idx" ON "relationships" USING btree ("scope_id");
--> statement-breakpoint
ALTER TABLE "social_dna_profiles" ADD COLUMN "scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "social_dna_profiles" ADD CONSTRAINT "social_dna_profiles_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "social_dna_profiles_scope_idx" ON "social_dna_profiles" USING btree ("scope_id");
--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "opportunities_scope_idx" ON "opportunities" USING btree ("scope_id");
--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "recommendations_scope_idx" ON "recommendations" USING btree ("scope_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION backfill_legacy_social_accounts()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
	INSERT INTO data_scopes (scope_type, user_id)
	SELECT DISTINCT 'PERSONAL', user_id
	FROM social_accounts
	WHERE user_id IS NOT NULL
	ON CONFLICT DO NOTHING;

	INSERT INTO social_external_accounts (
		platform_id, external_id, current_handle, display_name, profile_url,
		profile_image_url, bio, location, website, follower_count, following_count,
		visibility, metadata, first_observed_at, last_observed_at, created_at, updated_at
	)
	SELECT platform_id, external_id, handle, display_name, profile_url,
		profile_image_url, bio, location, website, follower_count, following_count,
		'UNKNOWN', metadata, COALESCE(last_sync_attempt_at, created_at), COALESCE(last_sync_at, updated_at), created_at, updated_at
	FROM social_accounts
	ON CONFLICT (platform_id, external_id) DO UPDATE SET
		current_handle = EXCLUDED.current_handle,
		display_name = EXCLUDED.display_name,
		profile_url = EXCLUDED.profile_url,
		profile_image_url = EXCLUDED.profile_image_url,
		bio = EXCLUDED.bio,
		location = EXCLUDED.location,
		website = EXCLUDED.website,
		follower_count = EXCLUDED.follower_count,
		following_count = EXCLUDED.following_count,
		last_observed_at = GREATEST(social_external_accounts.last_observed_at, EXCLUDED.last_observed_at),
		updated_at = now();

	INSERT INTO social_account_handles (external_account_id, handle, first_seen_at, last_seen_at)
	SELECT sea.id, sa.handle, sa.created_at, COALESCE(sa.updated_at, now())
	FROM social_accounts sa
	JOIN social_external_accounts sea ON sea.platform_id = sa.platform_id AND sea.external_id = sa.external_id
	WHERE sa.handle IS NOT NULL
	ON CONFLICT (external_account_id, handle) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at;

	INSERT INTO social_connections (
		scope_id, platform_id, external_account_id, status, credentials_encrypted,
		verified_external_id, verified_handle, sync_cursor, cursor_updated_at,
		last_sync_at, last_sync_attempt_at, sync_error, rate_limit_remaining,
		rate_limit_reset_at, provider_metadata, disconnected_at, created_at, updated_at
	)
	SELECT ds.id, sa.platform_id, sea.id,
		CASE
			WHEN sa.status IN ('CONNECTED', 'HEALTHY') THEN 'CONNECTED'
			WHEN sa.status IN ('AUTHENTICATION_EXPIRED', 'PERMISSION_MISSING') THEN 'REAUTH_REQUIRED'
			WHEN sa.status IN ('RATE_LIMITED', 'DEGRADED') THEN 'DEGRADED'
			WHEN sa.status = 'CONFIGURATION_UNAVAILABLE' THEN 'ERROR'
			WHEN sa.status = 'DEMO' THEN 'DISABLED'
			ELSE 'DISCONNECTED'
		END,
		sa.credentials_encrypted, sa.external_id, sa.handle, sa.sync_cursor,
		CASE WHEN sa.sync_cursor IS NULL THEN NULL ELSE COALESCE(sa.last_sync_at, sa.updated_at) END,
		sa.last_sync_at, sa.last_sync_attempt_at, sa.sync_error, sa.rate_limit_remaining,
		sa.rate_limit_reset_at, sa.metadata,
		CASE WHEN sa.status = 'DISCONNECTED' THEN COALESCE(sa.updated_at, now()) ELSE NULL END,
		sa.created_at, sa.updated_at
	FROM social_accounts sa
	JOIN data_scopes ds ON ds.scope_type = 'PERSONAL' AND ds.user_id = sa.user_id
	JOIN social_external_accounts sea ON sea.platform_id = sa.platform_id AND sea.external_id = sa.external_id
	WHERE sa.user_id IS NOT NULL
	ON CONFLICT (scope_id, platform_id) DO UPDATE SET
		external_account_id = EXCLUDED.external_account_id,
		status = EXCLUDED.status,
		credentials_encrypted = EXCLUDED.credentials_encrypted,
		verified_external_id = EXCLUDED.verified_external_id,
		verified_handle = EXCLUDED.verified_handle,
		sync_cursor = EXCLUDED.sync_cursor,
		cursor_updated_at = EXCLUDED.cursor_updated_at,
		last_sync_at = EXCLUDED.last_sync_at,
		last_sync_attempt_at = EXCLUDED.last_sync_attempt_at,
		sync_error = EXCLUDED.sync_error,
		rate_limit_remaining = EXCLUDED.rate_limit_remaining,
		rate_limit_reset_at = EXCLUDED.rate_limit_reset_at,
		provider_metadata = EXCLUDED.provider_metadata,
		updated_at = now();

	INSERT INTO social_account_observations (
		scope_id, connection_id, external_account_id, visibility, observed_at,
		normalization_version, adapter_version, metadata
	)
	SELECT sc.scope_id, sc.id, sc.external_account_id, 'UNKNOWN',
		COALESCE(sc.last_sync_at, sc.created_at), 'legacy-v1', 'legacy-backfill', sa.metadata
	FROM social_connections sc
	JOIN social_accounts sa ON sa.platform_id = sc.platform_id AND sa.user_id = (
		SELECT ds.user_id FROM data_scopes ds WHERE ds.id = sc.scope_id
	)
	WHERE sc.external_account_id IS NOT NULL
	ON CONFLICT (scope_id, external_account_id) DO NOTHING;
END;
$$;
--> statement-breakpoint
SELECT backfill_legacy_social_accounts();
