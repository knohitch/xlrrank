import { getPool } from "../client.js";

export interface ProviderRetentionPolicy {
  id: string;
  providerFamily: string;
  dataCategory: string;
  retentionClass: string;
  maxRetentionSeconds: number;
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
    max_retention_seconds: number;
    description: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT id, provider_family, data_category, retention_class,
             max_retention_seconds, description, metadata
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
  let receiptsPurged = 0;

  for (const policy of policies) {
    if (options.dataCategory && policy.dataCategory !== options.dataCategory) {
      continue;
    }

    const cutoff = new Date(now.getTime() - policy.maxRetentionSeconds * 1000);

    if (
      policy.dataCategory === "organization_content" ||
      policy.dataCategory === "member_content"
    ) {
      const isOrg = policy.dataCategory === "organization_content";
      const assetTypeCondition = isOrg
        ? "AND COALESCE(sc.provider_metadata->>'assetType', '') = 'LINKEDIN_ORGANIZATION'"
        : "AND COALESCE(sc.provider_metadata->>'assetType', '') != 'LINKEDIN_ORGANIZATION'";

      // 1. Purge content observations for connections belonging to this provider family
      const scopeFilter = options.scopeId ? "AND sco.scope_id = $3" : "";
      const params: unknown[] = [cutoff, providerFamily];
      if (options.scopeId) params.push(options.scopeId);

      if (dryRun) {
        const countRes = await pool.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_content_observations sco
            JOIN social_connections sc ON sc.id = sco.connection_id
            JOIN platforms p ON p.id = sc.platform_id
            WHERE sco.observed_at < $1
              AND (p.slug = $2 OR $2 = 'linkedin' AND p.slug = 'linkedin')
              ${assetTypeCondition}
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
            WHERE sco.connection_id = sc.id
              AND sc.platform_id = p.id
              AND (p.slug = $2 OR $2 = 'linkedin' AND p.slug = 'linkedin')
              ${assetTypeCondition}
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

    if (
      policy.dataCategory === "organization_profile" ||
      policy.dataCategory === "member_profile"
    ) {
      const isOrg = policy.dataCategory === "organization_profile";
      const assetTypeCondition = isOrg
        ? "AND COALESCE(sc.provider_metadata->>'assetType', '') = 'LINKEDIN_ORGANIZATION'"
        : "AND COALESCE(sc.provider_metadata->>'assetType', '') != 'LINKEDIN_ORGANIZATION'";

      const scopeFilter = options.scopeId ? "AND sao.scope_id = $3" : "";
      const params: unknown[] = [cutoff, providerFamily];
      if (options.scopeId) params.push(options.scopeId);

      if (dryRun) {
        const countRes = await pool.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_account_observations sao
            JOIN social_connections sc ON sc.id = sao.connection_id
            JOIN platforms p ON p.id = sc.platform_id
            WHERE sao.observed_at < $1
              AND (p.slug = $2 OR $2 = 'linkedin' AND p.slug = 'linkedin')
              ${assetTypeCondition}
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
            WHERE sao.connection_id = sc.id
              AND sc.platform_id = p.id
              AND (p.slug = $2 OR $2 = 'linkedin' AND p.slug = 'linkedin')
              ${assetTypeCondition}
              AND sao.observed_at < $1
              ${scopeFilter}
          `,
          params,
        );
        accountObservationsPurged += delObsRes.rowCount ?? 0;
      }
    }

    if (policy.dataCategory === "webhook_receipt") {
      if (dryRun) {
        const countRes = await pool.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM webhook_receipts
            WHERE provider_family = $1
              AND received_at < $2
          `,
          [providerFamily, cutoff],
        );
        receiptsPurged += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const delReceiptsRes = await pool.query(
          `
            DELETE FROM webhook_receipts
            WHERE provider_family = $1
              AND received_at < $2
          `,
          [providerFamily, cutoff],
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
    receiptsPurged,
    dryRun,
  };
}
