ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "queue_name" text;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "payload_version" integer;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "scope_id" uuid;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "connection_id" uuid;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "bullmq_job_id" text;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "retry_classification" text;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "failed_at" timestamp with time zone;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "ingestion_run_id" uuid;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "safe_error" jsonb;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "dead_lettered_at" timestamp with time zone;

DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_scope_id_data_scopes_id_fk"
    FOREIGN KEY ("scope_id") REFERENCES "public"."data_scopes"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_connection_id_social_connections_id_fk"
    FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_ingestion_run_id_social_ingestion_runs_id_fk"
    FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."social_ingestion_runs"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_payload_version_check"
    CHECK ("payload_version" IS NULL OR "payload_version" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_retry_classification_check"
    CHECK ("retry_classification" IS NULL OR "retry_classification" IN ('RETRYABLE', 'NON_RETRYABLE', 'REAUTH_REQUIRED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "jobs_queue_status_idx" ON "jobs" USING btree ("queue_name", "status");
CREATE INDEX IF NOT EXISTS "jobs_connection_status_idx" ON "jobs" USING btree ("connection_id", "status");
CREATE INDEX IF NOT EXISTS "jobs_next_retry_idx" ON "jobs" USING btree ("next_retry_at") WHERE "next_retry_at" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_active_social_connection_sync_unique"
  ON "jobs" USING btree ("type", "connection_id")
  WHERE "type" = 'social.connection.sync'
    AND "status" IN ('PENDING_DISPATCH', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED');
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_active_idempotency_unique"
  ON "jobs" USING btree ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL
    AND "status" IN ('PENDING_DISPATCH', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED');

CREATE TABLE IF NOT EXISTS "job_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid NOT NULL,
  "queue_name" text NOT NULL,
  "job_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "bullmq_job_id" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "locked_by" text,
  "locked_until" timestamp with time zone,
  "dispatched_at" timestamp with time zone,
  "last_error" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_outbox_status_check" CHECK ("status" IN ('PENDING', 'DISPATCHED', 'FAILED')),
  CONSTRAINT "job_outbox_payload_object_check" CHECK (jsonb_typeof("payload") = 'object')
);
DO $$ BEGIN
  ALTER TABLE "job_outbox" ADD CONSTRAINT "job_outbox_job_id_jobs_id_fk"
    FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "job_outbox_job_unique" ON "job_outbox" USING btree ("job_id");
CREATE INDEX IF NOT EXISTS "job_outbox_pending_idx"
  ON "job_outbox" USING btree ("status", "created_at")
  WHERE "status" IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS "job_outbox_lock_idx" ON "job_outbox" USING btree ("locked_until");

CREATE TABLE IF NOT EXISTS "social_sync_leases" (
  "connection_id" uuid PRIMARY KEY NOT NULL,
  "job_id" uuid NOT NULL,
  "owner_token" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  "acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "social_sync_leases" ADD CONSTRAINT "social_sync_leases_connection_id_social_connections_id_fk"
    FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "social_sync_leases" ADD CONSTRAINT "social_sync_leases_job_id_jobs_id_fk"
    FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "social_sync_leases_expires_idx" ON "social_sync_leases" USING btree ("expires_at");
CREATE INDEX IF NOT EXISTS "social_sync_leases_job_idx" ON "social_sync_leases" USING btree ("job_id");

ALTER TABLE "social_connections" ADD COLUMN IF NOT EXISTS "sync_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "social_connections" ADD COLUMN IF NOT EXISTS "schedule_cadence_seconds" integer;
ALTER TABLE "social_connections" ADD COLUMN IF NOT EXISTS "next_sync_at" timestamp with time zone;
ALTER TABLE "social_connections" ADD COLUMN IF NOT EXISTS "last_scheduled_at" timestamp with time zone;
DO $$ BEGIN
  ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_schedule_cadence_check"
    CHECK ("schedule_cadence_seconds" IS NULL OR "schedule_cadence_seconds" >= 60);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "social_connections_due_sync_idx"
  ON "social_connections" USING btree ("next_sync_at")
  WHERE "sync_enabled" = true;

CREATE TABLE IF NOT EXISTS "social_sync_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "cadence_seconds" integer NOT NULL,
  "next_sync_at" timestamp with time zone NOT NULL,
  "last_scheduled_at" timestamp with time zone,
  "locked_by" text,
  "locked_until" timestamp with time zone,
  "policy" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_sync_schedules_cadence_check" CHECK ("cadence_seconds" >= 60)
);
DO $$ BEGIN
  ALTER TABLE "social_sync_schedules" ADD CONSTRAINT "social_sync_schedules_connection_id_social_connections_id_fk"
    FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "social_sync_schedules_connection_unique" ON "social_sync_schedules" USING btree ("connection_id");
CREATE INDEX IF NOT EXISTS "social_sync_schedules_due_idx"
  ON "social_sync_schedules" USING btree ("next_sync_at")
  WHERE "enabled" = true;
CREATE INDEX IF NOT EXISTS "social_sync_schedules_lock_idx" ON "social_sync_schedules" USING btree ("locked_until");

CREATE TABLE IF NOT EXISTS "worker_heartbeats" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "worker_id" text NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'READY' NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata" jsonb,
  CONSTRAINT "worker_heartbeats_status_check" CHECK ("status" IN ('STARTING', 'READY', 'DRAINING', 'STOPPED', 'ERROR'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "worker_heartbeats_worker_unique" ON "worker_heartbeats" USING btree ("worker_id");
CREATE INDEX IF NOT EXISTS "worker_heartbeats_last_seen_idx" ON "worker_heartbeats" USING btree ("last_seen_at");

CREATE TABLE IF NOT EXISTS "job_dead_letters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid NOT NULL,
  "queue_name" text NOT NULL,
  "job_type" text NOT NULL,
  "connection_id" uuid,
  "ingestion_run_id" uuid,
  "safe_error" jsonb,
  "attempt_count" integer NOT NULL,
  "retry_classification" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_dead_letters_retry_check" CHECK ("retry_classification" IS NULL OR "retry_classification" IN ('RETRYABLE', 'NON_RETRYABLE', 'REAUTH_REQUIRED'))
);
DO $$ BEGIN
  ALTER TABLE "job_dead_letters" ADD CONSTRAINT "job_dead_letters_job_id_jobs_id_fk"
    FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "job_dead_letters" ADD CONSTRAINT "job_dead_letters_connection_id_social_connections_id_fk"
    FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "job_dead_letters" ADD CONSTRAINT "job_dead_letters_ingestion_run_id_social_ingestion_runs_id_fk"
    FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."social_ingestion_runs"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "job_dead_letters_job_unique" ON "job_dead_letters" USING btree ("job_id");
CREATE INDEX IF NOT EXISTS "job_dead_letters_connection_idx" ON "job_dead_letters" USING btree ("connection_id");
