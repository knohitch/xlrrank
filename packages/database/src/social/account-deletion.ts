import { JOB_TYPES } from "@xlrrank/queue";
import { getPool } from "../client.js";

const ACTIVE_JOB_STATUSES = ["PENDING_DISPATCH", "QUEUED", "RUNNING", "RETRY_SCHEDULED"] as const;

export interface AccountDeletionSocialCleanupResult {
  connectionsDisconnected: number;
  schedulesDisabled: number;
  leasesReleased: number;
  jobsCancelled: number;
}

function activeJobStatusList(): string {
  return ACTIVE_JOB_STATUSES.map((status) => `'${status}'`).join(", ");
}

export async function deactivatePersonalSocialAccessForAccountDeletion(
  userId: string,
): Promise<AccountDeletionSocialCleanupResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const disconnected = await client.query<{ id: string }>(
      `
        WITH owned_connections AS (
          SELECT sc.id
          FROM social_connections sc
          JOIN data_scopes ds ON ds.id = sc.scope_id
          WHERE ds.scope_type = 'PERSONAL'
            AND ds.user_id = $1
        )
        UPDATE social_connections sc
        SET status = 'DISCONNECTED',
            credentials_encrypted = NULL,
            sync_enabled = false,
            next_sync_at = NULL,
            disabled_at = NULL,
            disconnected_at = COALESCE(sc.disconnected_at, now()),
            updated_at = now()
        FROM owned_connections oc
        WHERE sc.id = oc.id
        RETURNING sc.id
      `,
      [userId],
    );
    const connectionIds = disconnected.rows.map((row) => row.id);

    let schedulesDisabled = 0;
    let leasesReleased = 0;
    let jobsCancelled = 0;
    if (connectionIds.length > 0) {
      const schedules = await client.query(
        `
          UPDATE social_sync_schedules
          SET enabled = false,
              locked_by = NULL,
              locked_until = NULL,
              updated_at = now()
          WHERE connection_id = ANY($1::uuid[])
        `,
        [connectionIds],
      );
      schedulesDisabled = schedules.rowCount ?? 0;

      const leases = await client.query(
        "DELETE FROM social_sync_leases WHERE connection_id = ANY($1::uuid[])",
        [connectionIds],
      );
      leasesReleased = leases.rowCount ?? 0;

      const jobs = await client.query(
        `
          UPDATE jobs
          SET status = 'CANCELLED',
              safe_error = jsonb_build_object(
                'name', 'AccountDeletionRequested',
                'message', 'Account deletion revoked social access before sync execution.'
              ),
              error = jsonb_build_object(
                'name', 'AccountDeletionRequested',
                'message', 'Account deletion revoked social access before sync execution.'
              ),
              retry_classification = 'NON_RETRYABLE',
              next_retry_at = NULL,
              updated_at = now()
          WHERE type = $2
            AND connection_id = ANY($1::uuid[])
            AND status IN (${activeJobStatusList()})
        `,
        [connectionIds, JOB_TYPES.socialConnectionSync],
      );
      jobsCancelled = jobs.rowCount ?? 0;
    }

    await client.query("COMMIT");
    return {
      connectionsDisconnected: connectionIds.length,
      schedulesDisabled,
      leasesReleased,
      jobsCancelled,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
