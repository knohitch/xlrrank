import type { Pool, PoolClient } from "pg";
import {
  decryptSecret,
  encryptSecret,
  providerAuthorizationAssetAssociatedData,
} from "@xlrrank/shared";
import { getPool } from "../client.js";

type QueryExecutor = Pool | PoolClient;

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
  executor?: QueryExecutor;
}

export interface PurgeRetentionResult {
  providerFamily: string;
  policiesEvaluated: number;
  accountObservationsPurged: number;
  accountProfilesSanitized: number;
  accountHandlesPurged: number;
  connectionProfileCachesSanitized: number;
  authorizationAssetsSanitized: number;
  authorizationAssetRolesExpired: number;
  contentObservationsPurged: number;
  interactionsPurged: number;
  canonicalItemsPurged: number;
  metricsPurged: number;
  receiptsPurged: number;
  dryRun: boolean;
}

export async function loadProviderRetentionPolicies(
  providerFamily = "linkedin",
  executor: QueryExecutor = getPool(),
): Promise<ProviderRetentionPolicy[]> {
  const res = await executor.query<{
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
  const executor = options.executor ?? getPool();
  const providerFamily = options.providerFamily ?? "linkedin";
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;

  const policies = await loadProviderRetentionPolicies(providerFamily, executor);
  let accountObservationsPurged = 0;
  let accountProfilesSanitized = 0;
  let accountHandlesPurged = 0;
  let connectionProfileCachesSanitized = 0;
  let authorizationAssetsSanitized = 0;
  let authorizationAssetRolesExpired = 0;
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
        const countRes = await executor.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_content_observations sco
            JOIN social_connections sc ON sc.id = sco.connection_id
            JOIN platforms p ON p.id = sc.platform_id
            JOIN social_content_items sci ON sci.id = sco.content_item_id
            WHERE sco.observed_at < $1
              AND COALESCE(p.provider_family, p.slug) = $2
              AND COALESCE(sco.provider_data_category, sci.provider_data_category) = $3
              ${scopeFilter}
          `,
          params,
        );
        contentObservationsPurged += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const delObsRes = await executor.query<{ content_item_id: string }>(
          `
            DELETE FROM social_content_observations sco
            USING social_connections sc, platforms p
                  , social_content_items sci
            WHERE sco.connection_id = sc.id
              AND sc.platform_id = p.id
              AND sci.id = sco.content_item_id
              AND COALESCE(p.provider_family, p.slug) = $2
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
          const orphanDel = await executor.query(
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
        const countRes = await executor.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_account_observations sao
            JOIN social_connections sc ON sc.id = sao.connection_id
            JOIN platforms p ON p.id = sc.platform_id
            JOIN social_external_accounts sea ON sea.id = sao.external_account_id
            WHERE sao.observed_at < $1
              AND COALESCE(p.provider_family, p.slug) = $2
              AND COALESCE(sao.provider_data_category, sea.provider_data_category) = $3
              ${scopeFilter}
          `,
          params,
        );
        accountObservationsPurged += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const delObsRes = await executor.query(
          `
            DELETE FROM social_account_observations sao
            USING social_connections sc, platforms p
                  , social_external_accounts sea
            WHERE sao.connection_id = sc.id
              AND sc.platform_id = p.id
              AND sea.id = sao.external_account_id
              AND COALESCE(p.provider_family, p.slug) = $2
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
      const params: unknown[] = [cutoff, providerFamily, policy.dataCategory];
      if (dryRun) {
        const countRes = await executor.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_external_accounts sea
            JOIN platforms p ON p.id = sea.platform_id
            WHERE sea.last_observed_at < $1
              AND COALESCE(p.provider_family, p.slug) = $2
              AND sea.provider_data_category = $3
              AND NOT EXISTS (
                SELECT 1
                FROM social_account_observations sao
                WHERE sao.external_account_id = sea.id
              )
              AND (
                sea.current_handle IS NOT NULL
                OR sea.display_name IS NOT NULL
                OR sea.profile_url IS NOT NULL
                OR sea.profile_image_url IS NOT NULL
                OR sea.bio IS NOT NULL
                OR sea.location IS NOT NULL
                OR sea.website IS NOT NULL
                OR sea.follower_count IS NOT NULL
                OR sea.following_count IS NOT NULL
                OR COALESCE(sea.metadata, '{}'::jsonb) <> '{}'::jsonb
              )
          `,
          params,
        );
        accountProfilesSanitized += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const sanitizeRes = await executor.query(
          `
            UPDATE social_external_accounts sea
            SET current_handle = NULL,
                display_name = NULL,
                profile_url = NULL,
                profile_image_url = NULL,
                bio = NULL,
                location = NULL,
                website = NULL,
                follower_count = NULL,
                following_count = NULL,
                metadata = jsonb_build_object(
                  'retentionRedactedAt', now(),
                  'retentionRedactionCategory', $3,
                  'stableProviderIdentifierRetained', true
                ),
                updated_at = now()
            FROM platforms p
            WHERE p.id = sea.platform_id
              AND sea.last_observed_at < $1
              AND COALESCE(p.provider_family, p.slug) = $2
              AND sea.provider_data_category = $3
              AND NOT EXISTS (
                SELECT 1
                FROM social_account_observations sao
                WHERE sao.external_account_id = sea.id
              )
          `,
          params,
        );
        accountProfilesSanitized += sanitizeRes.rowCount ?? 0;
      }
    }

    {
      const params: unknown[] = [cutoff, providerFamily, policy.dataCategory];
      if (dryRun) {
        const countRes = await executor.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_account_handles sah
            JOIN social_external_accounts sea ON sea.id = sah.external_account_id
            JOIN platforms p ON p.id = sea.platform_id
            WHERE sah.last_seen_at < $1
              AND COALESCE(p.provider_family, p.slug) = $2
              AND COALESCE(sah.provider_data_category, sea.provider_data_category) = $3
              AND NOT EXISTS (
                SELECT 1
                FROM social_account_observations sao
                WHERE sao.external_account_id = sea.id
                  AND COALESCE(sao.provider_data_category, sea.provider_data_category) = $3
                  AND sao.observed_at >= $1
              )
          `,
          params,
        );
        accountHandlesPurged += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const delHandlesRes = await executor.query(
          `
            DELETE FROM social_account_handles sah
            USING social_external_accounts sea, platforms p
            WHERE sea.id = sah.external_account_id
              AND p.id = sea.platform_id
              AND sah.last_seen_at < $1
              AND COALESCE(p.provider_family, p.slug) = $2
              AND COALESCE(sah.provider_data_category, sea.provider_data_category) = $3
              AND NOT EXISTS (
                SELECT 1
                FROM social_account_observations sao
                WHERE sao.external_account_id = sea.id
                  AND COALESCE(sao.provider_data_category, sea.provider_data_category) = $3
                  AND sao.observed_at >= $1
              )
          `,
          params,
        );
        accountHandlesPurged += delHandlesRes.rowCount ?? 0;
      }
    }

    {
      const scopeFilter = options.scopeId ? `AND sc.scope_id = ${scopeParamIndex}` : "";
      const params: unknown[] = [cutoff, providerFamily, policy.dataCategory];
      if (options.scopeId) params.push(options.scopeId);

      const staleConnectionPredicate = `
        sc.status IN ('CONNECTED', 'DEGRADED', 'REAUTH_REQUIRED', 'DISCONNECTED')
        AND COALESCE(p.provider_family, p.slug) = $2
        AND sea.provider_data_category = $3
        AND (
          sc.verified_handle IS NOT NULL
          OR sc.provider_metadata ? 'displayName'
          OR sc.provider_metadata ? 'handle'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM social_account_observations sao
          WHERE sao.external_account_id = sea.id
            AND sao.scope_id = sc.scope_id
            AND COALESCE(sao.provider_data_category, sea.provider_data_category) = $3
            AND sao.observed_at >= $1
        )
        ${scopeFilter}
      `;

      if (dryRun) {
        const countRes = await executor.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_connections sc
            JOIN social_external_accounts sea ON sea.id = sc.external_account_id
            JOIN platforms p ON p.id = sc.platform_id
            WHERE ${staleConnectionPredicate}
          `,
          params,
        );
        connectionProfileCachesSanitized += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const sanitizeRes = await executor.query(
          `
            UPDATE social_connections sc
            SET verified_handle = NULL,
                provider_metadata = jsonb_strip_nulls(
                  COALESCE(sc.provider_metadata, '{}'::jsonb)
                    - 'displayName'
                    - 'handle'
                    || jsonb_build_object(
                      'retentionProfileCacheRedactedAt', now(),
                      'retentionProfileCacheRedactionCategory', $3
                    )
                ),
                updated_at = now()
            FROM social_external_accounts sea, platforms p
            WHERE sea.id = sc.external_account_id
              AND p.id = sc.platform_id
              AND ${staleConnectionPredicate}
          `,
          params,
        );
        connectionProfileCachesSanitized += sanitizeRes.rowCount ?? 0;
      }
    }

    {
      const params: unknown[] = [cutoff, providerFamily, policy.dataCategory];
      if (dryRun) {
        const countRes = await executor.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM provider_authorization_assets paa
            JOIN provider_authorizations pa ON pa.id = paa.provider_authorization_id
            WHERE paa.updated_at < $1
              AND pa.provider_family = $2
              AND paa.provider_data_category = $3
              AND (
                paa.name IS NOT NULL
                OR paa.handle IS NOT NULL
                OR (COALESCE(paa.metadata, '{}'::jsonb) - 'organizationUrn' - 'memberUrn'
                    - 'numericId' - 'roles' - 'primaryRole' - 'access' - 'providerDataCategory'
                    - 'providerRetentionBasis' - 'profileDecorationExpiresAt') <> '{}'::jsonb
              )
          `,
          params,
        );
        authorizationAssetsSanitized += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const sanitizeRes = await executor.query(
          `
            UPDATE provider_authorization_assets paa
            SET name = NULL,
                handle = NULL,
                metadata = jsonb_strip_nulls(jsonb_build_object(
                  'organizationUrn', paa.metadata->'organizationUrn',
                  'memberUrn', paa.metadata->'memberUrn',
                  'numericId', paa.metadata->'numericId',
                  'roles', paa.metadata->'roles',
                  'primaryRole', paa.metadata->'primaryRole',
                  'access', paa.metadata->'access',
                  'accessState', paa.metadata->'accessState',
                  'rolesRetentionExpiredAt', paa.metadata->'rolesRetentionExpiredAt',
                  'rolesRetentionCategory', paa.metadata->'rolesRetentionCategory',
                  'providerDataCategory', paa.provider_data_category,
                  'providerRetentionBasis', paa.metadata->'providerRetentionBasis',
                  'retentionRedactedAt', now(),
                  'retentionRedactionCategory', $3,
                  'stableProviderIdentifierRetained', true
                )),
                updated_at = now()
            FROM provider_authorizations pa
            WHERE pa.id = paa.provider_authorization_id
              AND paa.updated_at < $1
              AND pa.provider_family = $2
              AND paa.provider_data_category = $3
          `,
          params,
        );
        authorizationAssetsSanitized += sanitizeRes.rowCount ?? 0;
      }
    }

    if (policy.dataCategory === "organization_admin_reporting") {
      const params: unknown[] = [cutoff, providerFamily, policy.dataCategory];
      const staleRolesPredicate = `
        pa.provider_family = $2
        AND paa.metadata->>'roleProviderDataCategory' = $3
        AND COALESCE((paa.metadata->>'roleObservedAt')::timestamptz, paa.updated_at) < $1
        AND (
          paa.metadata ? 'roles'
          OR paa.metadata ? 'primaryRole'
        )
      `;
      if (dryRun) {
        const countRes = await executor.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM provider_authorization_assets paa
            JOIN provider_authorizations pa ON pa.id = paa.provider_authorization_id
            WHERE ${staleRolesPredicate}
          `,
          params,
        );
        authorizationAssetRolesExpired += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const expiredAssetIds = await executor.query<{
          id: string;
          provider_authorization_id: string;
          scope_id: string;
          provider_family: string;
          platform_slug: string;
          provider_asset_id: string;
          credentials_encrypted: string | null;
        }>(
          `
            UPDATE provider_authorization_assets paa
            SET metadata = jsonb_strip_nulls(
                  COALESCE(paa.metadata, '{}'::jsonb)
                    - 'roles'
                    - 'primaryRole'
                    || jsonb_build_object(
                      'rolesRetentionExpiredAt', now(),
                      'rolesRetentionCategory', $3,
                      'accessState', 'ACCESS_REQUIRED'
                    )
                )
            FROM provider_authorizations pa, platforms p
            WHERE pa.id = paa.provider_authorization_id
              AND p.id = paa.platform_id
              AND ${staleRolesPredicate}
            RETURNING paa.id, paa.provider_authorization_id, pa.scope_id, pa.provider_family,
                      p.slug AS platform_slug, paa.provider_asset_id, paa.credentials_encrypted
          `,
          params,
        );
        authorizationAssetRolesExpired += expiredAssetIds.rowCount ?? 0;
        const ids = expiredAssetIds.rows.map((row) => row.id);
        if (ids.length > 0) {
          await sanitizeAuthorizationAssetCredentialRoles(executor, expiredAssetIds.rows);
          await executor.query(
            `
              UPDATE social_connections sc
              SET status = CASE WHEN status = 'CONNECTED' THEN 'DEGRADED' ELSE status END,
                  provider_metadata = jsonb_strip_nulls(
                    COALESCE(provider_metadata, '{}'::jsonb)
                      - 'roles'
                      - 'primaryRole'
                      - 'grantedCapabilities'
                      || jsonb_build_object(
                        'rolesRetentionExpiredAt', now(),
                        'rolesRetentionCategory', $2::text,
                        'accessState', 'ACCESS_REQUIRED'
                      )
                  ),
                  sync_error = jsonb_build_object(
                    'code', 'PROVIDER_ADMIN_ROLE_RETENTION_EXPIRED',
                    'message', 'Provider-derived admin role data expired and requires revalidation'
                  ),
                  updated_at = now()
              WHERE provider_metadata->>'providerAuthorizationAssetId' = ANY($1::text[])
            `,
            [ids, policy.dataCategory],
          );
        }
      }
    }

    {
      const scopeFilter = options.scopeId ? `AND sio.scope_id = ${scopeParamIndex}` : "";
      const params: unknown[] = [cutoff, providerFamily, policy.dataCategory];
      if (options.scopeId) params.push(options.scopeId);

      if (dryRun) {
        const countRes = await executor.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_interaction_observations sio
            JOIN social_connections sc ON sc.id = sio.connection_id
            JOIN platforms p ON p.id = sc.platform_id
            JOIN social_interactions si ON si.id = sio.interaction_id
            WHERE si.occurred_at < $1
              AND COALESCE(p.provider_family, p.slug) = $2
              AND COALESCE(sio.provider_data_category, si.provider_data_category) = $3
              ${scopeFilter}
          `,
          params,
        );
        interactionsPurged += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const delObsRes = await executor.query<{ interaction_id: string }>(
          `
            DELETE FROM social_interaction_observations sio
            USING social_connections sc, platforms p, social_interactions si
            WHERE sio.connection_id = sc.id
              AND sc.platform_id = p.id
              AND si.id = sio.interaction_id
              AND COALESCE(p.provider_family, p.slug) = $2
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
          const orphanDel = await executor.query(
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
        const countRes = await executor.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM social_content_metrics scm
            JOIN social_connections sc ON sc.id = scm.connection_id
            JOIN platforms p ON p.id = sc.platform_id
            WHERE scm.collected_at < $1
              AND COALESCE(p.provider_family, p.slug) = $2
              AND scm.provider_data_category = $3
              ${scopeFilter}
          `,
          params,
        );
        metricsPurged += Number(countRes.rows[0]?.count ?? 0);
      } else {
        const delMetricsRes = await executor.query(
          `
            DELETE FROM social_content_metrics scm
            USING social_connections sc, platforms p
            WHERE scm.connection_id = sc.id
              AND sc.platform_id = p.id
              AND COALESCE(p.provider_family, p.slug) = $2
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
        const countRes = await executor.query<{ count: string }>(
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
        const delReceiptsRes = await executor.query(
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
    accountProfilesSanitized,
    accountHandlesPurged,
    connectionProfileCachesSanitized,
    authorizationAssetsSanitized,
    authorizationAssetRolesExpired,
    contentObservationsPurged,
    interactionsPurged,
    canonicalItemsPurged,
    metricsPurged,
    receiptsPurged,
    dryRun,
  };
}

async function sanitizeAuthorizationAssetCredentialRoles(
  executor: QueryExecutor,
  assets: Array<{
    id: string;
    provider_authorization_id: string;
    scope_id: string;
    provider_family: string;
    platform_slug: string;
    provider_asset_id: string;
    credentials_encrypted: string | null;
  }>,
): Promise<void> {
  for (const asset of assets) {
    if (!asset.credentials_encrypted) continue;
    const aad = providerAuthorizationAssetAssociatedData({
      authorizationAssetId: asset.id,
      authorizationId: asset.provider_authorization_id,
      scopeId: asset.scope_id,
      platformSlug: asset.platform_slug,
      providerAssetId: asset.provider_asset_id,
    });
    const parsed = JSON.parse(decryptSecret(asset.credentials_encrypted, undefined, aad)) as {
      metadata?: Record<string, unknown>;
      [key: string]: unknown;
    };
    const metadata = { ...(parsed.metadata ?? {}) };
    delete metadata.roles;
    delete metadata.primaryRole;
    delete metadata.roleObservedAt;
    delete metadata.roleProviderDataCategory;
    parsed.metadata = {
      ...metadata,
      rolesRetentionExpiredAt: new Date().toISOString(),
      accessState: "ACCESS_REQUIRED",
    };
    const encrypted = encryptSecret(JSON.stringify(parsed), undefined, aad);
    await executor.query(
      `
        UPDATE provider_authorization_assets
        SET credentials_encrypted = $2
        WHERE id = $1
      `,
      [asset.id, encrypted],
    );
  }
}
