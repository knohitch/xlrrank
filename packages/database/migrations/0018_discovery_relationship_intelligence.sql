CREATE TABLE IF NOT EXISTS "discovery_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_key" text NOT NULL,
	"version" text NOT NULL,
	"config" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discovery_policies_key_version_unique" ON "discovery_policies" USING btree ("policy_key","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_policies_active_idx" ON "discovery_policies" USING btree ("policy_key","active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discovery_policies_one_active_unique" ON "discovery_policies" USING btree ("policy_key") WHERE "active" = true;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "relationship_intelligence_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_key" text NOT NULL,
	"version" text NOT NULL,
	"config" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relationship_intelligence_policies_key_version_unique" ON "relationship_intelligence_policies" USING btree ("policy_key","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relationship_intelligence_policies_active_idx" ON "relationship_intelligence_policies" USING btree ("policy_key","active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relationship_intelligence_policies_one_active_unique" ON "relationship_intelligence_policies" USING btree ("policy_key") WHERE "active" = true;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "relationship_intelligence_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"from_person_id" uuid NOT NULL,
	"to_person_id" uuid NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"strength_label" text NOT NULL,
	"directional_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_key" text NOT NULL,
	"policy_version" text NOT NULL,
	"algorithm_version" text NOT NULL,
	"evaluation_at" timestamp with time zone NOT NULL,
	"source_fingerprint" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'relationship_intelligence_snapshots_scope_id_data_scopes_id_fk') THEN
		ALTER TABLE "relationship_intelligence_snapshots" ADD CONSTRAINT "relationship_intelligence_snapshots_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'relationship_intelligence_snapshots_from_person_id_people_id_fk') THEN
		ALTER TABLE "relationship_intelligence_snapshots" ADD CONSTRAINT "relationship_intelligence_snapshots_from_person_id_people_id_fk" FOREIGN KEY ("from_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'relationship_intelligence_snapshots_to_person_id_people_id_fk') THEN
		ALTER TABLE "relationship_intelligence_snapshots" ADD CONSTRAINT "relationship_intelligence_snapshots_to_person_id_people_id_fk" FOREIGN KEY ("to_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relationship_intelligence_fingerprint_unique" ON "relationship_intelligence_snapshots" USING btree ("scope_id","from_person_id","to_person_id","policy_key","policy_version","algorithm_version","source_fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relationship_intelligence_current_idx" ON "relationship_intelligence_snapshots" USING btree ("scope_id","from_person_id","to_person_id","is_current");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "discovery_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"subject_person_id" uuid,
	"policy_key" text NOT NULL,
	"policy_version" text NOT NULL,
	"relationship_policy_key" text,
	"relationship_policy_version" text,
	"algorithm_version" text NOT NULL,
	"query" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evaluation_at" timestamp with time zone NOT NULL,
	"source_fingerprint" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovery_snapshots_scope_id_data_scopes_id_fk') THEN
		ALTER TABLE "discovery_snapshots" ADD CONSTRAINT "discovery_snapshots_scope_id_data_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovery_snapshots_subject_person_id_people_id_fk') THEN
		ALTER TABLE "discovery_snapshots" ADD CONSTRAINT "discovery_snapshots_subject_person_id_people_id_fk" FOREIGN KEY ("subject_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discovery_snapshots_fingerprint_unique" ON "discovery_snapshots" USING btree ("scope_id","policy_key","policy_version","algorithm_version","source_fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_snapshots_current_idx" ON "discovery_snapshots" USING btree ("scope_id","subject_person_id","is_current");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "discovery_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"target_person_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovery_results_snapshot_id_discovery_snapshots_id_fk') THEN
		ALTER TABLE "discovery_results" ADD CONSTRAINT "discovery_results_snapshot_id_discovery_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."discovery_snapshots"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovery_results_target_person_id_people_id_fk') THEN
		ALTER TABLE "discovery_results" ADD CONSTRAINT "discovery_results_target_person_id_people_id_fk" FOREIGN KEY ("target_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discovery_results_snapshot_target_unique" ON "discovery_results" USING btree ("snapshot_id","target_person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_results_snapshot_rank_idx" ON "discovery_results" USING btree ("snapshot_id","rank");--> statement-breakpoint
