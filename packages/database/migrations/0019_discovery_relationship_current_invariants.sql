WITH ranked_relationships AS (
	SELECT
		"id",
		ROW_NUMBER() OVER (
			PARTITION BY "scope_id", "from_person_id", "to_person_id", "policy_key"
			ORDER BY "evaluation_at" DESC, "created_at" DESC, "id" DESC
		) AS row_number
	FROM "relationship_intelligence_snapshots"
	WHERE "is_current" = true
)
UPDATE "relationship_intelligence_snapshots" snapshot
SET "is_current" = false,
	"superseded_at" = COALESCE(snapshot."superseded_at", now())
FROM ranked_relationships ranked
WHERE snapshot."id" = ranked."id"
	AND ranked.row_number > 1;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "relationship_intelligence_one_current_per_policy_unique"
ON "relationship_intelligence_snapshots" USING btree (
	"scope_id",
	"from_person_id",
	"to_person_id",
	"policy_key"
)
WHERE "is_current" = true;--> statement-breakpoint

WITH ranked_discovery AS (
	SELECT
		"id",
		ROW_NUMBER() OVER (
			PARTITION BY
				"scope_id",
				COALESCE("subject_person_id", '00000000-0000-0000-0000-000000000000'::uuid),
				"policy_key",
				COALESCE("relationship_policy_key", '')
			ORDER BY "evaluation_at" DESC, "created_at" DESC, "id" DESC
		) AS row_number
	FROM "discovery_snapshots"
	WHERE "is_current" = true
)
UPDATE "discovery_snapshots" snapshot
SET "is_current" = false,
	"superseded_at" = COALESCE(snapshot."superseded_at", now())
FROM ranked_discovery ranked
WHERE snapshot."id" = ranked."id"
	AND ranked.row_number > 1;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "discovery_snapshots_one_current_per_policy_unique"
ON "discovery_snapshots" USING btree (
	"scope_id",
	COALESCE("subject_person_id", '00000000-0000-0000-0000-000000000000'::uuid),
	"policy_key",
	COALESCE("relationship_policy_key", '')
)
WHERE "is_current" = true;--> statement-breakpoint
