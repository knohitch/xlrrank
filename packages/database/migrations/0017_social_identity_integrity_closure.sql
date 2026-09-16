DROP INDEX IF EXISTS "canonical_person_accounts_active_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canonical_person_accounts_confirmed_unique"
ON "canonical_person_accounts" USING btree ("scope_id","external_account_id")
WHERE "status" = 'CONFIRMED';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "social_dna_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_key" text NOT NULL,
	"version" text NOT NULL,
	"config" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "social_dna_policies_key_version_unique" ON "social_dna_policies" USING btree ("policy_key","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_dna_policies_active_idx" ON "social_dna_policies" USING btree ("policy_key","active");--> statement-breakpoint
WITH ranked_social_dna_policies AS (
	SELECT id, row_number() OVER (PARTITION BY policy_key ORDER BY updated_at DESC, created_at DESC, id DESC) AS rank
	FROM "social_dna_policies"
	WHERE active = true
)
UPDATE "social_dna_policies"
SET active = false, updated_at = now()
WHERE id IN (SELECT id FROM ranked_social_dna_policies WHERE rank > 1);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "social_dna_policies_one_active_unique"
ON "social_dna_policies" USING btree ("policy_key")
WHERE "active" = true;--> statement-breakpoint

WITH ranked_identity_policies AS (
	SELECT id, row_number() OVER (PARTITION BY policy_key ORDER BY updated_at DESC, created_at DESC, id DESC) AS rank
	FROM "identity_resolution_policies"
	WHERE active = true
)
UPDATE "identity_resolution_policies"
SET active = false, updated_at = now()
WHERE id IN (SELECT id FROM ranked_identity_policies WHERE rank > 1);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_resolution_policies_one_active_unique"
ON "identity_resolution_policies" USING btree ("policy_key")
WHERE "active" = true;--> statement-breakpoint
