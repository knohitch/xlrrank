import type { PoolClient } from "pg";
import type {
  NormalizedContent,
  NormalizedInteraction,
  NormalizedProfile,
  RetryClassification,
} from "@xlrrank/social-core";
import {
  validateNormalizedContent,
  validateNormalizedInteraction,
  validateNormalizedProfile,
} from "@xlrrank/social-core";
import { getPool } from "../client.js";
import type { ScopeContext } from "./scope.js";

export interface SocialSyncPage {
  scope: ScopeContext;
  connectionId: string;
  platformId: string;
  ingestionRunId: string;
  cursorBefore: string | null;
  cursorAfter: string | null;
  profiles: NormalizedProfile[];
  content: NormalizedContent[];
  interactions: NormalizedInteraction[];
  normalizationVersion: string;
  adapterVersion: string;
  completeRun?: boolean;
}

export interface PersistedSocialPage {
  profilesProcessed: number;
  contentProcessed: number;
  interactionsProcessed: number;
  cursorAfter: string | null;
}

export async function beginSocialIngestionRun(input: {
  scope: ScopeContext;
  connectionId: string;
  platformId: string;
  cursorBefore: string | null;
  normalizationVersion: string;
}): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `
      INSERT INTO social_ingestion_runs (
        scope_id, connection_id, platform_id, status, cursor_before, normalization_version
      )
      VALUES ($1, $2, $3, 'RUNNING', $4, $5)
      RETURNING id
    `,
    [
      input.scope.scopeId,
      input.connectionId,
      input.platformId,
      input.cursorBefore,
      input.normalizationVersion,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to create social ingestion run");
  return row.id;
}

export async function markSocialIngestionFailed(input: {
  runId: string;
  error: Record<string, unknown>;
  retryClassification: RetryClassification;
}): Promise<void> {
  await getPool().query(
    `
      UPDATE social_ingestion_runs
      SET status = 'FAILED',
          errors = $2::jsonb,
          retry_classification = $3,
          completed_at = now()
      WHERE id = $1
    `,
    [input.runId, JSON.stringify([input.error]), input.retryClassification],
  );
}

export async function completeSocialIngestionRun(input: {
  runId: string;
  cursorAfter: string | null;
}): Promise<void> {
  await getPool().query(
    `
      UPDATE social_ingestion_runs
      SET status = 'COMPLETED',
          cursor_after = $2,
          completed_at = now()
      WHERE id = $1
    `,
    [input.runId, input.cursorAfter],
  );
}

export async function persistSocialSyncPage(input: SocialSyncPage): Promise<PersistedSocialPage> {
  for (const profile of input.profiles) validateNormalizedProfile(profile);
  for (const item of input.content) validateNormalizedContent(item);
  for (const interaction of input.interactions) validateNormalizedInteraction(interaction);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
      [input.connectionId],
    );
    if (!lock.rows[0]?.locked) {
      throw new Error("Social connection sync is already running");
    }

    await assertConnectionBelongsToScope(client, input.connectionId, input.scope.scopeId);

    const accountIds = new Map<string, string>();
    for (const profile of input.profiles) {
      const accountId = await upsertExternalAccount(client, profile);
      accountIds.set(profile.externalId, accountId);
      await upsertAccountObservation(client, input, accountId, profile);
    }

    const contentIds = new Map<string, string>();
    for (const item of input.content) {
      let authorId = accountIds.get(item.authorExternalId);
      if (!authorId) {
        authorId = await upsertExternalAccount(client, {
          platformId: item.platformId,
          externalId: item.authorExternalId,
          handle: item.authorExternalId,
          visibility: item.visibility,
          metadata: {},
        });
        accountIds.set(item.authorExternalId, authorId);
      }
      const contentId = await upsertContentItem(client, input.scope.scopeId, authorId, item);
      contentIds.set(item.externalId, contentId);
      await upsertContentObservation(client, input, contentId, item);
      if (item.metrics) {
        await upsertContentMetrics(client, input, contentId, item);
      }
    }

    for (const interaction of input.interactions) {
      let fromAccountId = accountIds.get(interaction.fromExternalId);
      if (!fromAccountId) {
        fromAccountId = await upsertExternalAccount(client, {
          platformId: interaction.platformId,
          externalId: interaction.fromExternalId,
          handle: interaction.fromExternalId,
          visibility: interaction.visibility,
          metadata: {},
        });
        accountIds.set(interaction.fromExternalId, fromAccountId);
      }
      const toAccountId = interaction.toAccountExternalId
        ? (accountIds.get(interaction.toAccountExternalId) ?? null)
        : null;
      const toContentId = interaction.toContentExternalId
        ? (contentIds.get(interaction.toContentExternalId) ?? null)
        : null;
      const interactionId = await upsertInteraction(
        client,
        input.scope.scopeId,
        fromAccountId,
        toContentId,
        toAccountId,
        interaction,
      );
      await upsertInteractionObservation(client, input, interactionId, interaction);
    }

    await client.query(
      `
        UPDATE social_ingestion_runs
        SET status = CASE WHEN $6 THEN 'COMPLETED' ELSE status END,
            cursor_after = $2,
            profiles_processed = profiles_processed + $3,
            content_processed = content_processed + $4,
            interactions_processed = interactions_processed + $5,
            completed_at = CASE WHEN $6 THEN now() ELSE completed_at END
        WHERE id = $1
      `,
      [
        input.ingestionRunId,
        input.cursorAfter,
        input.profiles.length,
        input.content.length,
        input.interactions.length,
        input.completeRun ?? true,
      ],
    );
    await client.query(
      `
        UPDATE social_connections
        SET sync_cursor = $3,
            cursor_updated_at = now(),
            last_sync_at = now(),
            last_sync_attempt_at = now(),
            sync_error = NULL,
            updated_at = now()
        WHERE id = $1 AND scope_id = $2
      `,
      [input.connectionId, input.scope.scopeId, input.cursorAfter],
    );
    await client.query("COMMIT");
    return {
      profilesProcessed: input.profiles.length,
      contentProcessed: input.content.length,
      interactionsProcessed: input.interactions.length,
      cursorAfter: input.cursorAfter,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function assertConnectionBelongsToScope(
  client: PoolClient,
  connectionId: string,
  scopeId: string,
): Promise<void> {
  const result = await client.query(
    "SELECT 1 FROM social_connections WHERE id = $1 AND scope_id = $2 AND status = 'CONNECTED'",
    [connectionId, scopeId],
  );
  if (result.rowCount !== 1) {
    throw new Error("Connection is not authorized for this scope or is not connected");
  }
}

async function upsertExternalAccount(
  client: PoolClient,
  profile: Pick<
    NormalizedProfile,
    | "platformId"
    | "externalId"
    | "handle"
    | "displayName"
    | "bio"
    | "location"
    | "website"
    | "profileImageUrl"
    | "followerCount"
    | "followingCount"
    | "visibility"
    | "providerDataCategory"
    | "metadata"
  >,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO social_external_accounts (
        platform_id, external_id, current_handle, display_name, profile_image_url,
        bio, location, website, follower_count, following_count, visibility, provider_data_category, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (platform_id, external_id) DO UPDATE SET
        current_handle = EXCLUDED.current_handle,
        display_name = COALESCE(EXCLUDED.display_name, social_external_accounts.display_name),
        profile_image_url = COALESCE(EXCLUDED.profile_image_url, social_external_accounts.profile_image_url),
        bio = COALESCE(EXCLUDED.bio, social_external_accounts.bio),
        location = COALESCE(EXCLUDED.location, social_external_accounts.location),
        website = COALESCE(EXCLUDED.website, social_external_accounts.website),
        follower_count = COALESCE(EXCLUDED.follower_count, social_external_accounts.follower_count),
        following_count = COALESCE(EXCLUDED.following_count, social_external_accounts.following_count),
        visibility = EXCLUDED.visibility,
        provider_data_category = COALESCE(EXCLUDED.provider_data_category, social_external_accounts.provider_data_category),
        metadata = EXCLUDED.metadata,
        last_observed_at = now(),
        updated_at = now()
      RETURNING id
    `,
    [
      profile.platformId,
      profile.externalId,
      profile.handle,
      profile.displayName ?? null,
      profile.profileImageUrl ?? null,
      profile.bio ?? null,
      profile.location ?? null,
      profile.website ?? null,
      profile.followerCount ?? null,
      profile.followingCount ?? null,
      profile.visibility,
      classifyProfileProviderDataCategory(profile),
      JSON.stringify(profile.metadata ?? {}),
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Failed to upsert external account");
  await client.query(
    `
      INSERT INTO social_account_handles (
        external_account_id, handle, provider_data_category, provider_retention_basis
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (external_account_id, handle)
      DO UPDATE SET
        provider_data_category = COALESCE(EXCLUDED.provider_data_category, social_account_handles.provider_data_category),
        provider_retention_basis = COALESCE(EXCLUDED.provider_retention_basis, social_account_handles.provider_retention_basis),
        last_seen_at = now()
    `,
    [
      id,
      profile.handle,
      classifyProfileProviderDataCategory(profile),
      stringMetadata(profile.metadata, "providerRetentionBasis"),
    ],
  );
  return id;
}

async function upsertAccountObservation(
  client: PoolClient,
  input: SocialSyncPage,
  accountId: string,
  profile: NormalizedProfile,
): Promise<void> {
  await client.query(
    `
      INSERT INTO social_account_observations (
        scope_id, connection_id, external_account_id, visibility, observed_at,
        provider_created_at, provider_data_category, normalization_version, adapter_version, ingestion_run_id, metadata
      )
      VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10)
      ON CONFLICT (scope_id, external_account_id) DO UPDATE SET
        connection_id = EXCLUDED.connection_id,
        visibility = EXCLUDED.visibility,
        observed_at = now(),
        provider_data_category = EXCLUDED.provider_data_category,
        normalization_version = EXCLUDED.normalization_version,
        adapter_version = EXCLUDED.adapter_version,
        ingestion_run_id = EXCLUDED.ingestion_run_id,
        metadata = EXCLUDED.metadata
    `,
    [
      input.scope.scopeId,
      input.connectionId,
      accountId,
      profile.visibility,
      profile.providerCreatedAt ?? null,
      classifyProfileProviderDataCategory(profile),
      input.normalizationVersion,
      input.adapterVersion,
      input.ingestionRunId,
      JSON.stringify(profile.metadata ?? {}),
    ],
  );
}

function contentScopeId(scopeId: string, visibility: string): string | null {
  return visibility === "PUBLIC" ? null : scopeId;
}

async function upsertContentItem(
  client: PoolClient,
  scopeId: string,
  authorAccountId: string,
  item: NormalizedContent,
): Promise<string> {
  const scopedId = contentScopeId(scopeId, item.visibility);
  if (scopedId === null) {
    const publicResult = await client.query<{ id: string }>(
      `
        INSERT INTO social_content_items (
          scope_id, platform_id, author_external_account_id, external_id, body,
          content_type, language, visibility, provider_created_at, provider_data_category, metadata
        )
        VALUES (NULL, $1, $2, $3, $4, $5, $6, 'PUBLIC', $7, $8, $9)
        ON CONFLICT (platform_id, external_id) WHERE scope_id IS NULL AND visibility = 'PUBLIC'
        DO UPDATE SET
          body = EXCLUDED.body,
          content_type = EXCLUDED.content_type,
          language = EXCLUDED.language,
          provider_created_at = EXCLUDED.provider_created_at,
          provider_data_category = EXCLUDED.provider_data_category,
          metadata = EXCLUDED.metadata,
          updated_at = now()
        RETURNING id
      `,
      [
        item.platformId,
        authorAccountId,
        item.externalId,
        item.body,
        item.contentType ?? null,
        item.language ?? null,
        item.externalCreatedAt ?? null,
        classifyContentProviderDataCategory(item),
        JSON.stringify(item.metadata ?? {}),
      ],
    );
    const publicId = publicResult.rows[0]?.id;
    if (!publicId) throw new Error("Failed to upsert public content");
    return publicId;
  }
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO social_content_items (
        scope_id, platform_id, author_external_account_id, external_id, body,
        content_type, language, visibility, provider_created_at, provider_data_category, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (scope_id, platform_id, external_id) WHERE scope_id IS NOT NULL
      DO UPDATE SET
        body = EXCLUDED.body,
        content_type = EXCLUDED.content_type,
        language = EXCLUDED.language,
        provider_created_at = EXCLUDED.provider_created_at,
        provider_data_category = EXCLUDED.provider_data_category,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id
    `,
    [
      scopedId,
      item.platformId,
      authorAccountId,
      item.externalId,
      item.body,
      item.contentType ?? null,
      item.language ?? null,
      item.visibility,
      item.externalCreatedAt ?? null,
      classifyContentProviderDataCategory(item),
      JSON.stringify(item.metadata ?? {}),
    ],
  );
  const privateId = result.rows[0]?.id;
  if (!privateId) throw new Error("Failed to upsert private content");
  return privateId;
}

async function upsertContentObservation(
  client: PoolClient,
  input: SocialSyncPage,
  contentId: string,
  item: NormalizedContent,
): Promise<void> {
  await client.query(
    `
      INSERT INTO social_content_observations (
        scope_id, connection_id, content_item_id, visibility, observed_at,
        provider_created_at, provider_data_category, normalization_version, adapter_version, ingestion_run_id, metadata
      )
      VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10)
      ON CONFLICT (scope_id, content_item_id) DO UPDATE SET
        connection_id = EXCLUDED.connection_id,
        visibility = EXCLUDED.visibility,
        observed_at = now(),
        provider_data_category = EXCLUDED.provider_data_category,
        normalization_version = EXCLUDED.normalization_version,
        adapter_version = EXCLUDED.adapter_version,
        ingestion_run_id = EXCLUDED.ingestion_run_id,
        metadata = EXCLUDED.metadata
    `,
    [
      input.scope.scopeId,
      input.connectionId,
      contentId,
      item.visibility,
      item.externalCreatedAt ?? null,
      classifyContentProviderDataCategory(item),
      input.normalizationVersion,
      input.adapterVersion,
      input.ingestionRunId,
      JSON.stringify(item.metadata ?? {}),
    ],
  );
}

async function upsertContentMetrics(
  client: PoolClient,
  input: SocialSyncPage,
  contentId: string,
  item: NormalizedContent,
): Promise<void> {
  const metrics = item.metrics;
  if (!metrics) return;
  await client.query(
    `
      INSERT INTO social_content_metrics (
        scope_id, connection_id, content_item_id, ingestion_run_id, snapshot_key,
        likes, comments, shares, impressions, engagement_rate, provider_data_category, provider_metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (scope_id, content_item_id, snapshot_key) DO NOTHING
    `,
    [
      input.scope.scopeId,
      input.connectionId,
      contentId,
      input.ingestionRunId,
      metrics.snapshotKey ?? input.ingestionRunId,
      metrics.likes ?? 0,
      metrics.comments ?? 0,
      metrics.shares ?? 0,
      metrics.impressions ?? 0,
      metrics.engagementRate ?? null,
      "organization_admin_reporting",
      JSON.stringify(item.metadata ?? {}),
    ],
  );
}

async function upsertInteraction(
  client: PoolClient,
  scopeId: string,
  fromAccountId: string,
  toContentId: string | null,
  toAccountId: string | null,
  interaction: NormalizedInteraction,
): Promise<string> {
  const scopedId = contentScopeId(scopeId, interaction.visibility);
  if (scopedId === null) {
    const publicResult = await client.query<{ id: string }>(
      `
        INSERT INTO social_interactions (
          scope_id, platform_id, external_id, from_external_account_id,
          to_content_item_id, to_external_account_id, type, body, visibility,
          occurred_at, provider_data_category, metadata
        )
        VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, 'PUBLIC', $8, $9, $10)
        ON CONFLICT (platform_id, external_id) WHERE scope_id IS NULL AND visibility = 'PUBLIC'
        DO UPDATE SET
          to_content_item_id = EXCLUDED.to_content_item_id,
          to_external_account_id = EXCLUDED.to_external_account_id,
          type = EXCLUDED.type,
          body = EXCLUDED.body,
          occurred_at = EXCLUDED.occurred_at,
          provider_data_category = EXCLUDED.provider_data_category,
          metadata = EXCLUDED.metadata,
          updated_at = now()
        RETURNING id
      `,
      [
        interaction.platformId,
        interaction.externalId,
        fromAccountId,
        toContentId,
        toAccountId,
        interaction.type,
        interaction.body ?? null,
        interaction.occurredAt,
        classifyInteractionProviderDataCategory(interaction),
        JSON.stringify(interaction.metadata ?? {}),
      ],
    );
    const publicId = publicResult.rows[0]?.id;
    if (!publicId) throw new Error("Failed to upsert public interaction");
    return publicId;
  }
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO social_interactions (
        scope_id, platform_id, external_id, from_external_account_id,
        to_content_item_id, to_external_account_id, type, body, visibility,
        occurred_at, provider_data_category, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (scope_id, platform_id, external_id) WHERE scope_id IS NOT NULL
      DO UPDATE SET
        to_content_item_id = EXCLUDED.to_content_item_id,
        to_external_account_id = EXCLUDED.to_external_account_id,
        type = EXCLUDED.type,
        body = EXCLUDED.body,
        occurred_at = EXCLUDED.occurred_at,
        provider_data_category = EXCLUDED.provider_data_category,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id
    `,
    [
      scopedId,
      interaction.platformId,
      interaction.externalId,
      fromAccountId,
      toContentId,
      toAccountId,
      interaction.type,
      interaction.body ?? null,
      interaction.visibility,
      interaction.occurredAt,
      classifyInteractionProviderDataCategory(interaction),
      JSON.stringify(interaction.metadata ?? {}),
    ],
  );
  const privateId = result.rows[0]?.id;
  if (!privateId) throw new Error("Failed to upsert private interaction");
  return privateId;
}

async function upsertInteractionObservation(
  client: PoolClient,
  input: SocialSyncPage,
  interactionId: string,
  interaction: NormalizedInteraction,
): Promise<void> {
  await client.query(
    `
      INSERT INTO social_interaction_observations (
        scope_id, connection_id, interaction_id, visibility, observed_at,
        provider_data_category, normalization_version, adapter_version, ingestion_run_id, metadata
      )
      VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9)
      ON CONFLICT (scope_id, interaction_id) DO UPDATE SET
        connection_id = EXCLUDED.connection_id,
        visibility = EXCLUDED.visibility,
        observed_at = now(),
        provider_data_category = EXCLUDED.provider_data_category,
        normalization_version = EXCLUDED.normalization_version,
        adapter_version = EXCLUDED.adapter_version,
        ingestion_run_id = EXCLUDED.ingestion_run_id,
        metadata = EXCLUDED.metadata
    `,
    [
      input.scope.scopeId,
      input.connectionId,
      interactionId,
      interaction.visibility,
      classifyInteractionProviderDataCategory(interaction),
      input.normalizationVersion,
      input.adapterVersion,
      input.ingestionRunId,
      JSON.stringify(interaction.metadata ?? {}),
    ],
  );
}

function providerCategoryFromMetadata(metadata: Record<string, unknown> | undefined): string | null {
  const category = metadata?.providerDataCategory;
  return typeof category === "string" && category.length > 0 ? category : null;
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function classifyProfileProviderDataCategory(
  profile: Pick<NormalizedProfile, "providerDataCategory" | "metadata">,
): string | null {
  return profile.providerDataCategory ?? providerCategoryFromMetadata(profile.metadata);
}

function classifyContentProviderDataCategory(
  content: Pick<NormalizedContent, "providerDataCategory" | "metadata">,
): string | null {
  return content.providerDataCategory ?? providerCategoryFromMetadata(content.metadata);
}

function classifyInteractionProviderDataCategory(
  interaction: Pick<NormalizedInteraction, "providerDataCategory" | "metadata">,
): string | null {
  return interaction.providerDataCategory ?? providerCategoryFromMetadata(interaction.metadata);
}
