import type { Pool, PoolClient } from "pg";
import { getPool } from "../client.js";

type QueryExecutor = Pool | PoolClient;

export interface ReconciliationCandidate {
  id: string;
  externalId: string;
  entityType: "CONTENT" | "INTERACTION" | "ACCOUNT";
  authorExternalId?: string | null;
  authorHandle?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ClaimReconciliationCandidatesInput {
  connectionId: string;
  scopeId: string;
  providerFamily: string;
  entityType: "CONTENT" | "INTERACTION" | "ACCOUNT";
  limit?: number;
}

export interface ClaimReconciliationCandidatesResult {
  checkpointId: string;
  lastProcessedId: string | null;
  candidates: ReconciliationCandidate[];
  hasMore: boolean;
}

export async function claimReconciliationCandidates(
  client: PoolClient,
  input: ClaimReconciliationCandidatesInput,
): Promise<ClaimReconciliationCandidatesResult> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 25));

  // Get or initialize checkpoint for connection and entity type
  const cpRes = await client.query<{ id: string; last_processed_id: string | null }>(
    `
      INSERT INTO provider_reconciliation_checkpoints (
        connection_id, scope_id, provider_family, entity_type, status, claimed_at
      )
      VALUES ($1, $2, $3, $4, 'RUNNING', now())
      ON CONFLICT (connection_id, entity_type)
      DO UPDATE SET
        status = 'RUNNING',
        claimed_at = now(),
        updated_at = now()
      RETURNING id, last_processed_id
    `,
    [input.connectionId, input.scopeId, input.providerFamily, input.entityType],
  );

  const checkpoint = cpRes.rows[0]!;
  const checkpointId = checkpoint.id;
  const cursorId = checkpoint.last_processed_id;

  let candidates: ReconciliationCandidate[] = [];

  if (input.entityType === "CONTENT") {
    const cursorFilter = cursorId ? "AND sci.id > $4" : "";
    const params: unknown[] = [input.connectionId, input.scopeId, limit];
    if (cursorId) params.push(cursorId);

    const rows = await client.query<{
      id: string;
      external_id: string;
      author_external_id: string | null;
      author_handle: string | null;
      metadata: Record<string, unknown> | null;
    }>(
      `
        SELECT sci.id, sci.external_id, sea.external_id AS author_external_id, sea.current_handle AS author_handle, sci.metadata
        FROM social_content_items sci
        JOIN social_content_observations sco ON sco.content_item_id = sci.id
        JOIN social_connections sc ON sc.id = sco.connection_id
        JOIN platforms p ON p.id = sc.platform_id
        JOIN social_external_accounts sea ON sea.id = sci.author_external_account_id
        WHERE sco.connection_id = $1
          AND sco.scope_id = $2
          AND sc.status = 'CONNECTED'
          AND COALESCE(p.provider_family, p.slug) = '${input.providerFamily.replaceAll("'", "''")}'
          ${cursorFilter}
        ORDER BY sci.id ASC
        LIMIT $3
        FOR UPDATE OF sci SKIP LOCKED
      `,
      params,
    );

    candidates = rows.rows.map((r) => ({
      id: r.id,
      externalId: r.external_id,
      entityType: "CONTENT",
      authorExternalId: r.author_external_id,
      authorHandle: r.author_handle,
      metadata: r.metadata,
    }));
  } else if (input.entityType === "INTERACTION") {
    const cursorFilter = cursorId ? "AND si.id > $4" : "";
    const params: unknown[] = [input.connectionId, input.scopeId, limit];
    if (cursorId) params.push(cursorId);

    const rows = await client.query<{
      id: string;
      external_id: string;
      author_external_id: string | null;
      author_handle: string | null;
      metadata: Record<string, unknown> | null;
    }>(
      `
        SELECT si.id, si.external_id, sea.external_id AS author_external_id, sea.current_handle AS author_handle, si.metadata
        FROM social_interactions si
        JOIN social_interaction_observations sio ON sio.interaction_id = si.id
        JOIN social_connections sc ON sc.id = sio.connection_id
        JOIN platforms p ON p.id = sc.platform_id
        JOIN social_external_accounts sea ON sea.id = si.from_external_account_id
        WHERE sio.connection_id = $1
          AND sio.scope_id = $2
          AND sc.status = 'CONNECTED'
          AND COALESCE(p.provider_family, p.slug) = '${input.providerFamily.replaceAll("'", "''")}'
          ${cursorFilter}
        ORDER BY si.id ASC
        LIMIT $3
        FOR UPDATE OF si SKIP LOCKED
      `,
      params,
    );

    candidates = rows.rows.map((r) => ({
      id: r.id,
      externalId: r.external_id,
      entityType: "INTERACTION",
      authorExternalId: r.author_external_id,
      authorHandle: r.author_handle,
      metadata: r.metadata,
    }));
  } else if (input.entityType === "ACCOUNT") {
    const cursorFilter = cursorId ? "AND sea.id > $4" : "";
    const params: unknown[] = [input.connectionId, input.scopeId, limit];
    if (cursorId) params.push(cursorId);

    const rows = await client.query<{
      id: string;
      external_id: string;
      current_handle: string | null;
      metadata: Record<string, unknown> | null;
    }>(
      `
        SELECT sea.id, sea.external_id, sea.current_handle, sea.metadata
        FROM social_external_accounts sea
        JOIN social_account_observations sao ON sao.external_account_id = sea.id
        JOIN social_connections sc ON sc.id = sao.connection_id
        JOIN platforms p ON p.id = sc.platform_id
        WHERE sao.connection_id = $1
          AND sao.scope_id = $2
          AND sc.status = 'CONNECTED'
          AND COALESCE(p.provider_family, p.slug) = '${input.providerFamily.replaceAll("'", "''")}'
          ${cursorFilter}
        ORDER BY sea.id ASC
        LIMIT $3
        FOR UPDATE OF sea SKIP LOCKED
      `,
      params,
    );

    candidates = rows.rows.map((r) => ({
      id: r.id,
      externalId: r.external_id,
      entityType: "ACCOUNT",
      authorHandle: r.current_handle,
      metadata: r.metadata,
    }));
  }

  const hasMore = candidates.length === limit;
  return {
    checkpointId,
    lastProcessedId: cursorId,
    candidates,
    hasMore,
  };
}

export async function advanceReconciliationCheckpoint(
  client: PoolClient,
  input: {
    checkpointId: string;
    lastProcessedId: string | null;
    hasMore: boolean;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  // If no more items in current cycle, reset last_processed_id to null so next run rescans cleanly
  const nextProcessedId = input.hasMore ? input.lastProcessedId : null;
  await client.query(
    `
      UPDATE provider_reconciliation_checkpoints
      SET last_processed_id = $2,
          last_reconciled_at = now(),
          status = 'IDLE',
          metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
          updated_at = now()
      WHERE id = $1
    `,
    [input.checkpointId, nextProcessedId, JSON.stringify(input.metadata ?? {})],
  );
}

export async function recordReconciliationFailure(
  client: PoolClient,
  checkpointId: string,
  error: unknown,
): Promise<void> {
  await client.query(
    `
      UPDATE provider_reconciliation_checkpoints
      SET status = 'FAILED',
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('lastError', $2::text),
          updated_at = now()
      WHERE id = $1
    `,
    [checkpointId, String(error)],
  );
}

export async function applyDeletedContentReconciliation(
  client: PoolClient,
  input: {
    contentItemId: string;
    connectionId: string;
    scopeId: string;
  },
): Promise<{ observationDeleted: boolean; itemDeleted: boolean }> {
  const delObs = await client.query(
    `
      DELETE FROM social_content_observations
      WHERE content_item_id = $1
        AND connection_id = $2
        AND scope_id = $3
    `,
    [input.contentItemId, input.connectionId, input.scopeId],
  );
  const observationDeleted = (delObs.rowCount ?? 0) > 0;

  // Clean orphan canonical item only if no other observation remains
  const orphanDel = await client.query(
    `
      DELETE FROM social_content_items
      WHERE id = $1
        AND NOT EXISTS (
          SELECT 1 FROM social_content_observations
          WHERE content_item_id = $1
        )
    `,
    [input.contentItemId],
  );
  const itemDeleted = (orphanDel.rowCount ?? 0) > 0;

  return { observationDeleted, itemDeleted };
}

export async function applyDeletedInteractionReconciliation(
  client: PoolClient,
  input: {
    interactionId: string;
    connectionId: string;
    scopeId: string;
  },
): Promise<{ observationDeleted: boolean; interactionDeleted: boolean }> {
  const delObs = await client.query(
    `
      DELETE FROM social_interaction_observations
      WHERE interaction_id = $1
        AND connection_id = $2
        AND scope_id = $3
    `,
    [input.interactionId, input.connectionId, input.scopeId],
  );
  const observationDeleted = (delObs.rowCount ?? 0) > 0;

  const orphanDel = await client.query(
    `
      DELETE FROM social_interactions
      WHERE id = $1
        AND NOT EXISTS (
          SELECT 1 FROM social_interaction_observations
          WHERE interaction_id = $1
        )
    `,
    [input.interactionId],
  );
  const interactionDeleted = (orphanDel.rowCount ?? 0) > 0;

  return { observationDeleted, interactionDeleted };
}

export async function applyDeletedAccountAuthorScrubbing(
  client: PoolClient,
  input: {
    authorExternalId: string;
    providerFamily: string;
    scopeId?: string;
  },
): Promise<{ contentScrubbed: number; interactionsScrubbed: number; accountsSanitized: number }> {
  // 1. Scrub author info from posts
  const contentRes = await client.query(
    `
      UPDATE social_content_items sci
      SET author_external_id = NULL,
          author_handle = '[deleted]',
          metadata = (COALESCE(sci.metadata, '{}'::jsonb) - 'author' - 'author_fullname')
            || jsonb_build_object('authorAnonymizedAt', now(), 'authorAnonymizedReason', 'ACCOUNT_DELETED'),
          updated_at = now()
      FROM platforms p
      WHERE p.id = sci.platform_id
        AND COALESCE(p.provider_family, p.slug) = $1
        AND sci.author_external_id = $2
    `,
    [input.providerFamily, input.authorExternalId],
  );
  const contentScrubbed = contentRes.rowCount ?? 0;

  // 2. Scrub author info from comments / interactions
  const intRes = await client.query(
    `
      UPDATE social_interactions si
      SET author_external_id = NULL,
          author_handle = '[deleted]',
          metadata = (COALESCE(si.metadata, '{}'::jsonb) - 'author' - 'author_fullname')
            || jsonb_build_object('authorAnonymizedAt', now(), 'authorAnonymizedReason', 'ACCOUNT_DELETED'),
          updated_at = now()
      FROM platforms p
      WHERE p.id = si.platform_id
        AND COALESCE(p.provider_family, p.slug) = $1
        AND si.author_external_id = $2
    `,
    [input.providerFamily, input.authorExternalId],
  );
  const interactionsScrubbed = intRes.rowCount ?? 0;

  // 3. Sanitize social_external_accounts if this external account exists
  const acctRes = await client.query(
    `
      UPDATE social_external_accounts sea
      SET current_handle = NULL,
          display_name = '[deleted]',
          profile_url = NULL,
          profile_image_url = NULL,
          bio = NULL,
          location = NULL,
          website = NULL,
          follower_count = NULL,
          following_count = NULL,
          metadata = jsonb_build_object(
            'accountDeletedAt', now(),
            'providerFamily', $1::text,
            'sanitized', true
          ),
          updated_at = now()
      FROM platforms p
      WHERE p.id = sea.platform_id
        AND COALESCE(p.provider_family, p.slug) = $1
        AND sea.external_id = $2
    `,
    [input.providerFamily, input.authorExternalId],
  );
  const accountsSanitized = acctRes.rowCount ?? 0;

  // Also remove handles
  await client.query(
    `
      DELETE FROM social_account_handles sah
      USING social_external_accounts sea, platforms p
      WHERE sea.id = sah.external_account_id
        AND p.id = sea.platform_id
        AND COALESCE(p.provider_family, p.slug) = $1
        AND sea.external_id = $2
    `,
    [input.providerFamily, input.authorExternalId],
  );

  return { contentScrubbed, interactionsScrubbed, accountsSanitized };
}
