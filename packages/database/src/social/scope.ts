import { getPool } from "../client.js";

export type DataScopeType = "PERSONAL" | "ORGANIZATION";
export type OrganizationCapability =
  "VIEW_SOCIAL_DATA" | "MANAGE_SOCIAL_CONNECTIONS" | "TRIGGER_SOCIAL_SYNC" | "MANAGE_ORGANIZATION";

export interface ScopeContext {
  scopeId: string;
  scopeType: DataScopeType;
  userId: string;
  organizationId: string | null;
}

export async function ensurePersonalScope(userId: string): Promise<ScopeContext> {
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    scope_type: DataScopeType;
    user_id: string;
    organization_id: string | null;
  }>(
    `
      INSERT INTO data_scopes (scope_type, user_id)
      VALUES ('PERSONAL', $1)
      ON CONFLICT (user_id) WHERE scope_type = 'PERSONAL'
      DO UPDATE SET updated_at = now()
      RETURNING id, scope_type, user_id, organization_id
    `,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to resolve personal data scope");
  return {
    scopeId: row.id,
    scopeType: row.scope_type,
    userId: row.user_id,
    organizationId: row.organization_id,
  };
}

export async function ensureOrganizationScope(organizationId: string): Promise<string> {
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `
      INSERT INTO data_scopes (scope_type, organization_id)
      VALUES ('ORGANIZATION', $1)
      ON CONFLICT (organization_id) WHERE scope_type = 'ORGANIZATION'
      DO UPDATE SET updated_at = now()
      RETURNING id
    `,
    [organizationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to resolve organization data scope");
  return row.id;
}

export async function authorizeScope(
  userId: string,
  scopeId: string,
  capability: OrganizationCapability = "VIEW_SOCIAL_DATA",
): Promise<ScopeContext | null> {
  const pool = getPool();
  const result = await pool.query<{
    scope_id: string;
    scope_type: DataScopeType;
    user_id: string | null;
    organization_id: string | null;
  }>(
    `
      SELECT ds.id AS scope_id, ds.scope_type, ds.user_id, ds.organization_id
      FROM data_scopes ds
      WHERE ds.id = $1
        AND (
          (ds.scope_type = 'PERSONAL' AND ds.user_id = $2)
          OR (
            ds.scope_type = 'ORGANIZATION'
            AND EXISTS (
              SELECT 1
              FROM organization_members om
              LEFT JOIN organization_member_permissions omp
                ON omp.member_id = om.id AND omp.capability = $3
              WHERE om.organization_id = ds.organization_id
                AND om.user_id = $2
                AND (om.role IN ('owner', 'admin') OR omp.capability IS NOT NULL)
            )
          )
        )
    `,
    [scopeId, userId, capability],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    scopeId: row.scope_id,
    scopeType: row.scope_type,
    userId,
    organizationId: row.organization_id,
  };
}

export async function authorizeConnection(
  userId: string,
  connectionId: string,
  capability: OrganizationCapability = "VIEW_SOCIAL_DATA",
): Promise<ScopeContext | null> {
  const pool = getPool();
  const result = await pool.query<{ scope_id: string }>(
    "SELECT scope_id FROM social_connections WHERE id = $1",
    [connectionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return authorizeScope(userId, row.scope_id, capability);
}
