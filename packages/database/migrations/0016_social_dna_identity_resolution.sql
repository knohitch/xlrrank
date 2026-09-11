ALTER TABLE "social_dna_profiles" ADD COLUMN IF NOT EXISTS "stated_signals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "social_dna_profiles" ADD COLUMN IF NOT EXISTS "observed_signals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "social_dna_profiles" ADD COLUMN IF NOT EXISTS "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "social_dna_profiles" ADD COLUMN IF NOT EXISTS "algorithm_version" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "social_dna_profiles" ADD COLUMN IF NOT EXISTS "source_fingerprint" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "social_dna_profiles" ADD COLUMN IF NOT EXISTS "source_window" jsonb;--> statement-breakpoint
ALTER TABLE "social_dna_profiles" ADD COLUMN IF NOT EXISTS "is_current" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "social_dna_profiles" ADD COLUMN IF NOT EXISTS "superseded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_dna_current_idx" ON "social_dna_profiles" USING btree ("person_id","is_current");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "social_dna_person_algorithm_fingerprint_unique" ON "social_dna_profiles" USING btree ("person_id","algorithm_version","source_fingerprint");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "canonical_person_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"external_account_id" uuid NOT NULL,
	"status" text DEFAULT 'CONFIRMED' NOT NULL,
	"source_candidate_id" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"split_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canonical_person_accounts_scope_id_data_scopes_id_fk') THEN
		ALTER TABLE "canonical_person_accounts" ADD CONSTRAINT "canonical_person_accounts_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canonical_person_accounts_person_id_people_id_fk') THEN
		ALTER TABLE "canonical_person_accounts" ADD CONSTRAINT "canonical_person_accounts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canonical_person_accounts_external_account_id_social_external_accounts_id_fk') THEN
		ALTER TABLE "canonical_person_accounts" ADD CONSTRAINT "canonical_person_accounts_external_account_id_social_external_accounts_id_fk" FOREIGN KEY ("external_account_id") REFERENCES "public"."social_external_accounts"("id") ON DELETE restrict ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_person_accounts_scope_idx" ON "canonical_person_accounts" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_person_accounts_person_idx" ON "canonical_person_accounts" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canonical_person_accounts_active_unique" ON "canonical_person_accounts" USING btree ("scope_id","external_account_id","status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "identity_resolution_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_key" text NOT NULL,
	"version" text NOT NULL,
	"config" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_resolution_policies_key_version_unique" ON "identity_resolution_policies" USING btree ("policy_key","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_resolution_policies_active_idx" ON "identity_resolution_policies" USING btree ("policy_key","active");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "identity_resolution_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"account_a_id" uuid NOT NULL,
	"account_b_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"confidence" text DEFAULT 'LOW' NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contradictions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_key" text NOT NULL,
	"policy_version" text NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identity_resolution_candidates_scope_id_data_scopes_id_fk') THEN
		ALTER TABLE "identity_resolution_candidates" ADD CONSTRAINT "identity_resolution_candidates_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identity_resolution_candidates_account_a_id_social_external_accounts_id_fk') THEN
		ALTER TABLE "identity_resolution_candidates" ADD CONSTRAINT "identity_resolution_candidates_account_a_id_social_external_accounts_id_fk" FOREIGN KEY ("account_a_id") REFERENCES "public"."social_external_accounts"("id") ON DELETE restrict ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identity_resolution_candidates_account_b_id_social_external_accounts_id_fk') THEN
		ALTER TABLE "identity_resolution_candidates" ADD CONSTRAINT "identity_resolution_candidates_account_b_id_social_external_accounts_id_fk" FOREIGN KEY ("account_b_id") REFERENCES "public"."social_external_accounts"("id") ON DELETE restrict ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identity_resolution_candidates_decided_by_user_id_users_id_fk') THEN
		ALTER TABLE "identity_resolution_candidates" ADD CONSTRAINT "identity_resolution_candidates_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_resolution_pair_evidence_unique" ON "identity_resolution_candidates" USING btree ("scope_id","account_a_id","account_b_id","policy_key","policy_version","evidence_fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_resolution_candidates_scope_idx" ON "identity_resolution_candidates" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_resolution_candidates_status_idx" ON "identity_resolution_candidates" USING btree ("status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "identity_resolution_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"previous_status" text,
	"new_status" text NOT NULL,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identity_resolution_decisions_candidate_id_identity_resolution_candidates_id_fk') THEN
		ALTER TABLE "identity_resolution_decisions" ADD CONSTRAINT "identity_resolution_decisions_candidate_id_identity_resolution_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."identity_resolution_candidates"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identity_resolution_decisions_actor_user_id_users_id_fk') THEN
		ALTER TABLE "identity_resolution_decisions" ADD CONSTRAINT "identity_resolution_decisions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_resolution_decisions_candidate_idx" ON "identity_resolution_decisions" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_resolution_decisions_actor_idx" ON "identity_resolution_decisions" USING btree ("actor_user_id");
