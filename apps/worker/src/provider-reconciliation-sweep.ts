import {
  advanceReconciliationCheckpoint,
  applyDeletedAccountAuthorScrubbing,
  applyDeletedContentReconciliation,
  applyDeletedInteractionReconciliation,
  claimReconciliationCandidates,
  getPool,
  loadConnectionForSync,
  recordReconciliationFailure,
  safeJobError,
} from "@xlrrank/database";
import { getEnv } from "@xlrrank/config";
import { createChildLogger, getMetrics } from "@xlrrank/observability";
import { decryptSecret, socialCredentialAssociatedData } from "@xlrrank/shared";
import {
  connectorRegistry,
  type ConnectorCredentials,
  type ReconcileResourceItem,
} from "@xlrrank/social-core";
import { ensureWorkerConnectors } from "./social-sync-processor.js";

const logger = createChildLogger("worker.provider-reconciliation");
const metrics = getMetrics();

const RECONCILIATION_ENTITY_TYPES = ["CONTENT", "INTERACTION", "ACCOUNT"] as const;

export interface ProviderReconciliationSweepRun {
  workerId: string;
  connectionsAttempted: number;
  connectionsProcessed: number;
  itemsReconciled: number;
  itemsDeleted: number;
  authorsScrubbed: number;
}

export async function runProviderReconciliationSweepOnce(
  workerId: string,
): Promise<ProviderReconciliationSweepRun> {
  const pool = getPool();
  const env = getEnv();
  const sweepTimeoutMs = env.PROVIDER_RECONCILIATION_SWEEP_TIMEOUT_MS;
  const sweepSignal = AbortSignal.timeout(sweepTimeoutMs);
  const maxBatchesPerRun = Number(process.env.PROVIDER_RECONCILIATION_MAX_BATCHES_PER_RUN) || 5;

  ensureWorkerConnectors();

  const connectionsRes = await pool.query<{
    id: string;
    scope_id: string;
    platform_slug: string;
    provider_family: string;
  }>(
    `
      SELECT sc.id, sc.scope_id, p.slug AS platform_slug,
             COALESCE(p.provider_family, p.slug) AS provider_family
      FROM social_connections sc
      JOIN platforms p ON p.id = sc.platform_id
      WHERE sc.status = 'CONNECTED'
      ORDER BY sc.updated_at ASC
    `,
  );

  const run: ProviderReconciliationSweepRun = {
    workerId,
    connectionsAttempted: connectionsRes.rows.length,
    connectionsProcessed: 0,
    itemsReconciled: 0,
    itemsDeleted: 0,
    authorsScrubbed: 0,
  };

  for (const connection of connectionsRes.rows) {
    if (sweepSignal.aborted) {
      logger.warn("Reconciliation sweep timed out; skipping remaining connections");
      break;
    }

    const connector = connectorRegistry.create(connection.platform_slug);
    if (!connector || typeof connector.reconcileResources !== "function") {
      continue;
    }

    const connDetail = await loadConnectionForSync(connection.id);
    if (!connDetail || !connDetail.credentialsEncrypted) {
      continue;
    }

    let credentials: ConnectorCredentials;
    try {
      const plaintext = decryptSecret(
        connDetail.credentialsEncrypted,
        undefined,
        socialCredentialAssociatedData({
          connectionId: connDetail.id,
          scopeId: connDetail.scopeId,
          platformSlug: connDetail.platformSlug,
        }),
      );
      credentials = JSON.parse(plaintext) as ConnectorCredentials;
    } catch (err) {
      logger.warn(
        { err: safeJobError(err), connectionId: connection.id },
        "Reconciliation skipped connection with unreadable credentials",
      );
      continue;
    }

    const lockKey = advisoryLockKey(`reconciliation:${connection.id}`);
    const client = await pool.connect();
    let locked = false;

    try {
      const lockRes = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        lockKey,
      );
      locked = lockRes.rows[0]?.locked === true;
      if (!locked) {
        continue;
      }

      run.connectionsProcessed += 1;

      for (const entityType of RECONCILIATION_ENTITY_TYPES) {
        if (sweepSignal.aborted) {
          logger.warn("Reconciliation sweep timed out; stopping entity type loop");
          break;
        }

        let hasMore = true;
        let batchesRun = 0;

        while (hasMore && batchesRun < maxBatchesPerRun) {
          if (sweepSignal.aborted) {
            logger.warn("Reconciliation sweep timed out; stopping batch processing");
            break;
          }

          // Step 1: Claim candidates in a short transaction
          let claimResult;
          await client.query("BEGIN");
          try {
            claimResult = await claimReconciliationCandidates(client, {
              connectionId: connection.id,
              scopeId: connection.scope_id,
              providerFamily: connection.provider_family,
              entityType,
              limit: 50,
            });
            await client.query("COMMIT");
          } catch (claimErr) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw claimErr;
          }

          const checkpointId = claimResult.checkpointId;

          if (claimResult.candidates.length === 0) {
            await client.query("BEGIN");
            try {
              await advanceReconciliationCheckpoint(client, {
                checkpointId: claimResult.checkpointId,
                lastProcessedId: null,
                hasMore: false,
              });
              await client.query("COMMIT");
            } catch (advErr) {
              await client.query("ROLLBACK").catch(() => undefined);
              throw advErr;
            }
            hasMore = false;
            break;
          }

          batchesRun += 1;

          // Step 2: Network call OUTSIDE of any database transaction
          const items: ReconcileResourceItem[] = claimResult.candidates.map((c) => ({
            id: c.id,
            externalId: c.externalId,
            entityType: c.entityType,
            lookupKey: c.authorHandle ?? undefined,
            metadata: c.metadata ?? undefined,
          }));

          let reconcileResult;
          try {
            reconcileResult = await connector.reconcileResources(items, {
              scopeId: connection.scope_id,
              connectionId: connection.id,
              credentials,
              signal: sweepSignal,
            });
          } catch (netErr) {
            if (checkpointId) {
              await recordReconciliationFailure(client, checkpointId, netErr).catch(() => undefined);
            }
            logger.error(
              {
                err: safeJobError(netErr),
                connectionId: connection.id,
                entityType,
              },
              "Reconciliation network call failed",
            );
            hasMore = false;
            break;
          }

          run.itemsReconciled += claimResult.candidates.length;

          // Step 3: Finalize & Checkpoint in a short transaction
          await client.query("BEGIN");
          try {
            for (const status of reconcileResult.statuses) {
              // Never scrub or delete on UNKNOWN state
              if (status.state === "UNKNOWN") {
                continue;
              }

              const candidate = claimResult.candidates.find((c) => c.externalId === status.externalId);
              if (!candidate) continue;

              if (status.state === "DELETED") {
                if (entityType === "CONTENT") {
                  await applyDeletedContentReconciliation(client, {
                    contentItemId: candidate.id,
                    connectionId: connection.id,
                    scopeId: connection.scope_id,
                  });
                  run.itemsDeleted += 1;
                } else if (entityType === "INTERACTION") {
                  await applyDeletedInteractionReconciliation(client, {
                    interactionId: candidate.id,
                    connectionId: connection.id,
                    scopeId: connection.scope_id,
                  });
                  run.itemsDeleted += 1;
                }
              } else if (status.state === "ACCOUNT_DELETED") {
                if (entityType === "ACCOUNT") {
                  const scrubRes = await applyDeletedAccountAuthorScrubbing(client, {
                    authorExternalId: status.externalId,
                    providerFamily: connection.provider_family,
                    scopeId: connection.scope_id,
                  });
                  run.authorsScrubbed += scrubRes.contentScrubbed + scrubRes.interactionsScrubbed;
                }
              }

              if (status.authorDeleted) {
                if (candidate.authorExternalId) {
                  const scrubRes = await applyDeletedAccountAuthorScrubbing(client, {
                    authorExternalId: candidate.authorExternalId,
                    providerFamily: connection.provider_family,
                    scopeId: connection.scope_id,
                  });
                  run.authorsScrubbed += scrubRes.contentScrubbed + scrubRes.interactionsScrubbed;
                } else if (candidate.entityType === "CONTENT") {
                  await client.query(
                    `
                      UPDATE social_content_items
                      SET author_external_id = NULL,
                          author_handle = '[deleted]',
                          metadata = (COALESCE(metadata, '{}'::jsonb) - 'author' - 'author_fullname')
                            || jsonb_build_object('authorAnonymizedAt', now(), 'authorAnonymizedReason', 'ACCOUNT_DELETED'),
                          updated_at = now()
                      WHERE id = $1
                    `,
                    [candidate.id],
                  );
                  run.authorsScrubbed += 1;
                } else if (candidate.entityType === "INTERACTION") {
                  await client.query(
                    `
                      UPDATE social_interactions
                      SET author_external_id = NULL,
                          author_handle = '[deleted]',
                          metadata = (COALESCE(metadata, '{}'::jsonb) - 'author' - 'author_fullname')
                            || jsonb_build_object('authorAnonymizedAt', now(), 'authorAnonymizedReason', 'ACCOUNT_DELETED'),
                          updated_at = now()
                      WHERE id = $1
                    `,
                    [candidate.id],
                  );
                  run.authorsScrubbed += 1;
                }
              }
            }

            const lastId = claimResult.candidates[claimResult.candidates.length - 1]?.id ?? null;
            await advanceReconciliationCheckpoint(client, {
              checkpointId: claimResult.checkpointId,
              lastProcessedId: lastId,
              hasMore: claimResult.hasMore,
              metadata: {
                reconciledCount: claimResult.candidates.length,
                statusesCount: reconcileResult.statuses.length,
              },
            });

            await client.query("COMMIT");
            hasMore = claimResult.hasMore;
          } catch (finalizeErr) {
            await client.query("ROLLBACK").catch(() => undefined);
            if (checkpointId) {
              await recordReconciliationFailure(client, checkpointId, finalizeErr).catch(() => undefined);
            }
            logger.error(
              {
                err: safeJobError(finalizeErr),
                connectionId: connection.id,
                entityType,
              },
              "Reconciliation finalize batch failed",
            );
            hasMore = false;
            break;
          }

          // Step 4: Check Rate Limit feedback
          if (reconcileResult.rateLimit) {
            const { remaining, retryAfter } = reconcileResult.rateLimit;
            if (remaining === 0 || (typeof retryAfter === "number" && retryAfter > 0)) {
              logger.warn(
                {
                  connectionId: connection.id,
                  remaining,
                  retryAfter,
                  entityType,
                },
                "Reconciliation rate limit exhausted or backoff requested; preserving checkpoint and breaking",
              );
              hasMore = false;
              break;
            }
          }
        }
      }
    } catch (connErr) {
      logger.error(
        { err: safeJobError(connErr), connectionId: connection.id },
        "Reconciliation connection processing failed",
      );
    } finally {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1, $2)", lockKey).catch(() => undefined);
      }
      client.release();
    }
  }

  metrics.increment("worker.provider_reconciliation.completed");
  logger.info({ run }, "Provider reconciliation sweep completed");
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
