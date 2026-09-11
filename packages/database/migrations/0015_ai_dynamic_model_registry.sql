ALTER TABLE "ai_providers" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'CONFIGURATION_MISSING' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN IF NOT EXISTS "health" jsonb;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN IF NOT EXISTS "last_discovery_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN IF NOT EXISTS "last_successful_discovery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN IF NOT EXISTS "last_discovery_error" jsonb;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ai_provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"scope_kind" text DEFAULT 'SYSTEM' NOT NULL,
	"scope_id" uuid,
	"label" text DEFAULT 'default' NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"status" text DEFAULT 'CONFIGURED' NOT NULL,
	"health" jsonb,
	"last_validated_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "ai_provider_credentials" ADD CONSTRAINT "ai_provider_credentials_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_provider_credentials_provider_idx" ON "ai_provider_credentials" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_provider_credentials_scope_idx" ON "ai_provider_credentials" USING btree ("scope_kind","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_credentials_identity_unique" ON "ai_provider_credentials" USING btree ("provider_id","scope_kind","scope_id","label");--> statement-breakpoint

ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "capability_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "output_limit" integer;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "provider_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ai_model_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"credential_id" uuid,
	"runtime_key" text NOT NULL,
	"status" text DEFAULT 'AVAILABLE' NOT NULL,
	"capability_evidence" jsonb,
	"health" jsonb,
	"last_seen_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_probed_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "ai_model_availability" ADD CONSTRAINT "ai_model_availability_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_model_availability" ADD CONSTRAINT "ai_model_availability_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_model_availability" ADD CONSTRAINT "ai_model_availability_credential_id_ai_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."ai_provider_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_model_availability_runtime_unique" ON "ai_model_availability" USING btree ("model_id","runtime_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_model_availability_provider_idx" ON "ai_model_availability" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_model_availability_credential_idx" ON "ai_model_availability" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_model_availability_status_idx" ON "ai_model_availability" USING btree ("status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ai_model_capability_validations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"credential_id" uuid,
	"runtime_key" text NOT NULL,
	"capability" text NOT NULL,
	"status" text NOT NULL,
	"quality" integer,
	"latency_ms" integer,
	"safe_error" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "ai_model_capability_validations" ADD CONSTRAINT "ai_model_capability_validations_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_model_capability_validations" ADD CONSTRAINT "ai_model_capability_validations_credential_id_ai_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."ai_provider_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_model_capability_runtime_unique" ON "ai_model_capability_validations" USING btree ("model_id","runtime_key","capability");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_model_capability_status_idx" ON "ai_model_capability_validations" USING btree ("capability","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_model_capability_credential_idx" ON "ai_model_capability_validations" USING btree ("credential_id");
