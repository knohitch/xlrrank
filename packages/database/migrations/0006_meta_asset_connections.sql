DROP INDEX IF EXISTS "social_connections_scope_platform_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "social_connections_scope_platform_external_unique"
  ON "social_connections" USING btree ("scope_id", "platform_id", "verified_external_id");

CREATE INDEX IF NOT EXISTS "webhook_receipts_pending_idx"
  ON "webhook_receipts" USING btree ("status", "received_at")
  WHERE "status" IN ('RECEIVED', 'PENDING_DISPATCH', 'RETRY_SCHEDULED');

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
	ON CONFLICT (scope_id, platform_id, verified_external_id) DO UPDATE SET
		external_account_id = EXCLUDED.external_account_id,
		status = EXCLUDED.status,
		credentials_encrypted = EXCLUDED.credentials_encrypted,
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
