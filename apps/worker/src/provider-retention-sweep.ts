import { getEnv } from "@xlrrank/config";
import {
  getPool,
  loadProviderRetentionPolicies,
  purgeExpiredProviderData,
  safeJobError,
  type PurgeRetentionResult,
} from "@xlrrank/database";
import { createChildLogger, getMetrics } from "@xlrrank/observability";

const logger = createChildLogger("worker.provider-retention");
const metrics = getMetrics();

export interface ProviderRetentionSweepRun {
  workerId: string;
  attemptedProviders: number;
  acquiredProviders: number;
  skippedProviders: number;
  results: PurgeRetentionResult[];
}

export async function loadProviderRetentionSweepCadenceMs(configuredMs: number): Promise<number> {
  const pool = getPool();
  const shortest = await pool.query<{ shortest_seconds: number | null }>(
    `
      SELECT min(max_retention_seconds) AS shortest_seconds
      FROM provider_data_retention_policies
      WHERE max_retention_seconds IS NOT NULL
        AND retention_class <> 'SUPERSEDED_BY_0008'
    `,
  );
  const shortestMs = shortest.rows[0]?.shortest_seconds
    ? shortest.rows[0].shortest_seconds * 1000
    : configuredMs;
  return Math.min(configuredMs, Math.max(60_000, Math.floor(shortestMs / 4)));
}

export async function runProviderRetentionSweepOnce(workerId: string): Promise<ProviderRetentionSweepRun> {
  const pool = getPool();
  const env = getEnv();
  const providers = await pool.query<{ provider_family: string; shortest_seconds: number | null }>(
    `
      SELECT provider_family, min(max_retention_seconds) AS shortest_seconds
      FROM provider_data_retention_policies
      WHERE max_retention_seconds IS NOT NULL
        AND retention_class <> 'SUPERSEDED_BY_0008'
      GROUP BY provider_family
      ORDER BY provider_family
    `,
  );

  const run: ProviderRetentionSweepRun = {
    workerId,
    attemptedProviders: providers.rows.length,
    acquiredProviders: 0,
    skippedProviders: 0,
    results: [],
  };

  for (const provider of providers.rows) {
    const shortestMs = provider.shortest_seconds ? provider.shortest_seconds * 1000 : env.PROVIDER_RETENTION_SWEEP_INTERVAL_MS;
    const cadenceMs = Math.min(env.PROVIDER_RETENTION_SWEEP_INTERVAL_MS, Math.max(60_000, Math.floor(shortestMs / 4)));
    const windowStart = Math.floor(Date.now() / cadenceMs) * cadenceMs;
    const lockKey = advisoryLockKey(`${provider.provider_family}:${windowStart}`);
    const client = await pool.connect();
    let locked = false;
    try {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        lockKey,
      );
      locked = lock.rows[0]?.locked === true;
      if (!locked) {
        run.skippedProviders += 1;
        metrics.increment("worker.provider_retention.skipped");
        continue;
      }
      const claim = await client.query<{ id: string }>(
        `
          INSERT INTO provider_retention_sweep_claims (
            provider_family, window_start, claimed_by, status
          )
          VALUES ($1, $2, $3, 'RUNNING')
          ON CONFLICT (provider_family, window_start)
          DO UPDATE SET
            claimed_by = EXCLUDED.claimed_by,
            claimed_at = now(),
            status = 'RUNNING',
            completed_at = NULL,
            metadata = COALESCE(provider_retention_sweep_claims.metadata, '{}'::jsonb)
              || jsonb_build_object('retryClaimedAt', now(), 'retryClaimedBy', EXCLUDED.claimed_by)
          WHERE provider_retention_sweep_claims.status = 'FAILED'
          RETURNING id
        `,
        [provider.provider_family, new Date(windowStart), workerId],
      );
      const claimId = claim.rows[0]?.id;
      if (!claimId) {
        run.skippedProviders += 1;
        metrics.increment("worker.provider_retention.skipped");
        continue;
      }
      run.acquiredProviders += 1;
      await client.query("SELECT set_config('statement_timeout', $1, false)", [
        String(env.PROVIDER_RETENTION_SWEEP_TIMEOUT_MS),
      ]);
      const policies = await loadProviderRetentionPolicies(provider.provider_family, client);
      if (policies.length === 0) continue;
      const result = await purgeExpiredProviderData({
        providerFamily: provider.provider_family,
        executor: client,
      });
      run.results.push(result);
      await client.query(
        `
          UPDATE provider_retention_sweep_claims
          SET status = 'COMPLETED',
              completed_at = now(),
              metadata = $2::jsonb
          WHERE id = $1
        `,
        [claimId, JSON.stringify({ result })],
      );
      metrics.increment("worker.provider_retention.completed");
      logger.info(
        {
          workerId,
          providerFamily: provider.provider_family,
          cadenceMs,
          windowStart: new Date(windowStart).toISOString(),
          result,
        },
        "Provider retention sweep completed",
      );
    } catch (err) {
      await client.query("SELECT set_config('statement_timeout', '0', false)").catch(() => undefined);
      await client
        .query(
          `
            UPDATE provider_retention_sweep_claims
            SET status = 'FAILED',
                completed_at = now(),
                metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
            WHERE provider_family = $1
              AND window_start = $2
              AND status = 'RUNNING'
          `,
          [
            provider.provider_family,
            new Date(windowStart),
            JSON.stringify({ error: safeJobError(err), workerId }),
          ],
        )
        .catch(() => undefined);
      metrics.increment("worker.provider_retention.failed");
      logger.error(
        {
          err: safeJobError(err),
          workerId,
          providerFamily: provider.provider_family,
        },
        "Provider retention sweep failed",
      );
    } finally {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1, $2)", lockKey).catch(() => undefined);
      }
      await client.query("SELECT set_config('statement_timeout', '0', false)").catch(() => undefined);
      client.release();
    }
  }

  return run;
}

function advisoryLockKey(value: string): [number, number] {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x811c9dc5);
  }
  return [first | 0, second | 0];
}
