import { getPool } from "../client.js";

export interface ProviderRetentionPolicy {
  id: string;
  providerFamily: string;
  dataCategory: string;
  retentionClass: string;
  retentionMode: string;
  maxRetentionSeconds: number | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PurgeRetentionOptions {
  providerFamily?: string;
  dataCategory?: string;
  now?: Date;
  dryRun?: boolean;
  scopeId?: string;
}

export interface PurgeRetentionResult {
  providerFamily: string;
  policiesEvaluated: number;
  accountObservationsPurged: number;
  contentObservationsPurged: number;
  interactionsPurged: number;
  canonicalItemsPurged: number;
  metricsPurged: number;
  receiptsPurged: number;
  dryRun: boolean;
}

export async function loadProviderRetentionPolicies(
  providerFamily = "linkedin",
): Promise<ProviderRetentionPolicy[]> {
  const pool = getPool();
  const res = await pool.query<{
    id: string;
    provider_family: string;
    data_category: string;
    retention_class: string;
    retention_mode: string;
    max_retention_seconds: number | null;
    description: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT id, provider_family, data_category, retention_class,
             retention_mode, max_retention_seconds, description, metadata
      FROM provider_data_retention_policies
      WHERE provider_family = $1
      ORDER BY data_category
    `,
    [providerFamily],
  );

  return res.rows.map((row) => ({
    id: row.id,
    providerFamily: row.provider_family,
    dataCategory: row.data_category,
    retentionClass: row.retention_class,
    retentionMode: row.retention_mode,
    maxRetentionSeconds: row.max_retention_seconds,
    description: row.description,
    metadata: row.metadata,
  }));
}

export async function purgeExpiredProviderData(
  options: PurgeRetentionOptions = {},
): Promise<PurgeRetentionResult> {
  const pool = getPool();
  const providerFamily = options.providerFamily ?? "linkedin";
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;

  const policies = await loadProviderRetentionPolicies(providerFamily);
  let accountObservationsPurged = 0;
  let contentObservationsPurged = 0;
  let interactionsPurged = 0;
  let canonicalItemsPurged = 0;
  let metricsPurged = 0;
  let receiptsPurged = 0;

  for (const policy of policies) {
    if (options.dataCategory && policy.dataCategory !== options.dataCategory) {
      continue;
    }

    if (policy.maxRetentionSeconds === null) {
      continue;
    }

    const cutoff = new Date(now.getTime() - policy.maxRetentionSeconds * 1000);
    const scopeParamIndex = "$4";

    {
      const scopeFilter = options.scopeId ? `AND sco.scope_id = ${scopeParamIndex}` : "";
      const params: unknown[] = [cutoff, providerFamily, policy.dataCategory];
      if (options.scopeId) params.push(options.scopeId);

      if (dryRun) {
        const countRes = await pool.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_content_observations sco
            JOIN social_connections sc ON sc.id = sco.connection_id
            JOIN platforms p ON p.id = sc.platform_id
            JOIN social_content_items sci ON sci.id = sco.content_item_id
            WHERE sco.observed_at < $1
              AND p.slug = $2
              AND COALESCE(sco.provider_data_category, sci.provider_data_category) = $3
              ${scopeFilter}
          `,
          params,
        );
        contentObservationsPurged += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const delObsRes = await pool.query<{ content_item_id: string }>(
          `
            DELETE FROM social_content_observations sco
            USING social_connections sc, platforms p
                  , social_content_items sci
            WHERE sco.connection_id = sc.id
              AND sc.platform_id = p.id
              AND sci.id = sco.content_item_id
              AND p.slug = $2
              AND COALESCE(sco.provider_data_category, sci.provider_data_category) = $3
              AND sco.observed_at < $1
              ${scopeFilter}
            RETURNING sco.content_item_id
          `,
          params,
        );
        contentObservationsPurged += delObsRes.rowCount ?? 0;

        // Clean orphaned canonical items only if no other scope retains an observation
        const candidateItemIds = [...new Set(delObsRes.rows.map((r) => r.content_item_id))];
        if (candidateItemIds.length > 0) {
          const orphanDel = await pool.query(
            `
              DELETE FROM social_content_items sci
              WHERE sci.id = ANY($1::uuid[])
                AND NOT EXISTS (
                  SELECT 1 FROM social_content_observations sco
                  WHERE sco.content_item_id = sci.id
                )
            `,
            [candidateItemIds],
          );
          canonicalItemsPurged += orphanDel.rowCount ?? 0;
        }
      }
    }

    {
      const scopeFilter = options.scopeId ? `AND sao.scope_id = ${scopeParamIndex}` : "";
      const params: unknown[] = [cutoff, providerFamily, policy.dataCategory];
      if (options.scopeId) params.push(options.scopeId);

      if (dryRun) {
        const countRes = await pool.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_account_observations sao
            JOIN social_connections sc ON sc.id = sao.connection_id
            JOIN platforms p ON p.id = sc.platform_id
            JOIN social_external_accounts sea ON sea.id = sao.external_account_id
            WHERE sao.observed_at < $1
              AND p.slug = $2
              AND COALESCE(sao.provider_data_category, sea.provider_data_category) = $3
              ${scopeFilter}
          `,
          params,
        );
        accountObservationsPurged += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const delObsRes = await pool.query(
          `
            DELETE FROM social_account_observations sao
            USING social_connections sc, platforms p
                  , social_external_accounts sea
            WHERE sao.connection_id = sc.id
              AND sc.platform_id = p.id
              AND sea.id = sao.external_account_id
              AND p.slug = $2
              AND COALESCE(sao.provider_data_category, sea.provider_data_category) = $3
              AND sao.observed_at < $1
              ${scopeFilter}
          `,
          params,
        );
        accountObservationsPurged += delObsRes.rowCount ?? 0;
      }
    }

    {
      const scopeFilter = options.scopeId ? `AND sio.scope_id = ${scopeParamIndex}` : "";
      const params: unknown[] = [cutoff, providerFamily, policy.dataCategory];
      if (options.scopeId) params.push(options.scopeId);

      if (dryRun) {
        const countRes = await pool.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_interaction_observations sio
            JOIN social_connections sc ON sc.id = sio.connection_id
            JOIN platforms p ON p.id = sc.platform_id
            JOIN social_interactions si ON si.id = sio.interaction_id
            WHERE si.occurred_at < $1
              AND p.slug = $2
              AND COALESCE(sio.provider_data_category, si.provider_data_category) = $3
              ${scopeFilter}
          `,
          params,
        );
        interactionsPurged += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const delObsRes = await pool.query<{ interaction_id: string }>(
          `
            DELETE FROM social_interaction_observations sio
            USING social_connections sc, platforms p, social_interactions si
            WHERE sio.connection_id = sc.id
              AND sc.platform_id = p.id
              AND si.id = sio.interaction_id
              AND p.slug = $2
              AND COALESCE(sio.provider_data_category, si.provider_data_category) = $3
              AND si.occurred_at < $1
              ${scopeFilter}
            RETURNING sio.interaction_id
          `,
          params,
        );
        interactionsPurged += delObsRes.rowCount ?? 0;
        const candidateInteractionIds = [...new Set(delObsRes.rows.map((row) => row.interaction_id))];
        if (candidateInteractionIds.length > 0) {
          const orphanDel = await pool.query(
            `
              DELETE FROM social_interactions si
              WHERE si.id = ANY($1::uuid[])
                AND NOT EXISTS (
                  SELECT 1 FROM social_interaction_observations sio
                  WHERE sio.interaction_id = si.id
                )
            `,
            [candidateInteractionIds],
          );
          canonicalItemsPurged += orphanDel.rowCount ?? 0;
        }
      }
    }

    {
      const scopeFilter = options.scopeId ? `AND scm.scope_id = ${scopeParamIndex}` : "";
      const params: unknown[] = [cutoff, providerFamily, policy.dataCategory];
      if (options.scopeId) params.push(options.scopeId);

      if (dryRun) {
        const countRes = await pool.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_content_metrics scm
            JOIN social_connections sc ON sc.id = scm.connection_id
            JOIN platforms p ON p.id = sc.platform_id
            WHERE scm.collected_at < $1
              AND p.slug = $2
              AND scm.provider_data_category = $3
              ${scopeFilter}
          `,
          params,
        );
        metricsPurged += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const delMetricsRes = await pool.query(
          `
            DELETE FROM social_content_metrics scm
            USING social_connections sc, platforms p
            WHERE scm.connection_id = sc.id
              AND sc.platform_id = p.id
              AND p.slug = $2
              AND scm.provider_data_category = $3
              AND scm.collected_at < $1
              ${scopeFilter}
          `,
          params,
        );
        metricsPurged += delMetricsRes.rowCount ?? 0;
      }
    }

    if (policy.dataCategory === "webhook_operational_receipt") {
      if (dryRun) {
        const countRes = await pool.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM webhook_receipts
            WHERE provider_family = $1
              AND provider_data_category = $3
              AND received_at < $2
          `,
          [providerFamily, cutoff, policy.dataCategory],
        );
        receiptsPurged += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const delReceiptsRes = await pool.query(
          `
            DELETE FROM webhook_receipts
            WHERE provider_family = $1
              AND provider_data_category = $3
              AND received_at < $2
          `,
          [providerFamily, cutoff, policy.dataCategory],
        );
        receiptsPurged += delReceiptsRes.rowCount ?? 0;
      }
    }
  }

  return {
    providerFamily,
    policiesEvaluated: policies.length,
    accountObservationsPurged,
    contentObservationsPurged,
    interactionsPurged,
    canonicalItemsPurged,
    metricsPurged,
    receiptsPurged,
    dryRun,
  };
}
