import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { getDb, getPool } from "@xlrrank/database";
import { auditLogs, users, userRoles, roles } from "@xlrrank/database/schema";
import { getRolesForUser } from "@xlrrank/database";
import { ROLES, isAdminRole, type Role } from "@xlrrank/auth";
import { encryptSecret, providerAppSecretAssociatedData } from "../common/encryption.js";

export interface AdminUserSummary {
  id: string;
  email: string;
  displayName: string;
  status: string;
  emailVerified: boolean;
  roles: Role[];
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface ProviderAppConfigDto {
  id: string;
  platformId: string;
  platformSlug: string;
  environment: string;
  clientId: string;
  redirectUri: string;
  enabled: boolean;
  clientSecretConfigured: boolean;
  metadata: Record<string, unknown>;
  updatedAt: Date;
}

@Injectable()
export class AdminService {
  async listUsers(options: {
    page: number;
    pageSize: number;
    search?: string;
    status?: string;
  }): Promise<{ items: AdminUserSummary[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, options.page);
    const pageSize = Math.min(100, Math.max(1, options.pageSize));
    const offset = (page - 1) * pageSize;

    const whereParts: string[] = [];
    const params: unknown[] = [];

    if (options.status) {
      whereParts.push(`status = $${params.length + 1}`);
      params.push(options.status);
    }
    if (options.search) {
      const like = `%${options.search.toLowerCase()}%`;
      whereParts.push(
        `(lower(email) like $${params.length + 1} OR lower(display_name) like $${params.length + 2})`,
      );
      params.push(like, like);
    }

    const whereSql = whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : "";

    const pool = getPool();
    const countRes = await pool.query<{ count: number }>(
      `SELECT count(*)::int as count FROM users${whereSql}`,
      params,
    );
    const total = countRes.rows[0]?.count ?? 0;

    const dataRes = await pool.query(
      `SELECT id, email, display_name as "displayName", avatar_url as "avatarUrl", status, email_verified_at as "emailVerifiedAt", created_at as "createdAt", last_login_at as "lastLoginAt" FROM users${whereSql} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );

    const items: AdminUserSummary[] = [];
    for (const u of dataRes.rows) {
      const roles = await getRolesForUser(u.id);
      items.push({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        status: u.status as string,
        emailVerified: !!u.emailVerifiedAt,
        roles,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
      });
    }

    return { items, total, page, pageSize };
  }

  async setUserStatus(userId: string, status: string, actorUserId: string): Promise<void> {
    const db = getDb();
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!existing[0]) throw new NotFoundException("User not found.");
    if (actorUserId === userId && status !== "ACTIVE") {
      throw new ForbiddenException("Administrators cannot deactivate their own account.");
    }
    if (status !== "ACTIVE") {
      await this.assertCanRemoveOperationalPrivileges(userId);
    }
    await db
      .update(users)
      .set({ status: status as never, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async setUserRoles(
    userId: string,
    roleNames: Role[],
    actorUserId: string,
  ): Promise<{ roles: Role[] }> {
    const db = getDb();
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!existing[0]) throw new NotFoundException("User not found.");

    const normalized = this.normalizeRoles(roleNames);
    if (actorUserId === userId && !normalized.includes("SUPER_ADMIN")) {
      throw new ForbiddenException("SUPER_ADMIN users cannot remove their own SUPER_ADMIN role.");
    }
    const currentRoles = await getRolesForUser(userId);
    if (currentRoles.includes("SUPER_ADMIN") && !normalized.includes("SUPER_ADMIN")) {
      await this.assertAnotherActiveSuperAdmin(userId);
    }
    if (currentRoles.some(isAdminRole) && !normalized.some(isAdminRole)) {
      await this.assertAnotherActiveAdmin(userId);
    }

    await db.delete(userRoles).where(eq(userRoles.userId, userId));
    for (const roleName of normalized) {
      await db.insert(userRoles).values({ userId, roleName }).onConflictDoNothing();
    }
    return { roles: normalized };
  }

  async listRoles(): Promise<{ roles: { name: Role; description: string | null }[] }> {
    const db = getDb();
    const rows = await db.select().from(roles);
    return {
      roles: rows.map((r) => ({
        name: r.name as Role,
        description: r.description,
      })),
    };
  }

  async dashboardSummary() {
    const db = getDb();
    const totalUsers = await db.select({ count: sql<number>`count(*)::int` }).from(users);
    const activeUsers = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.status, "ACTIVE" as never));
    return {
      totalUsers: totalUsers[0]?.count ?? 0,
      activeUsers: activeUsers[0]?.count ?? 0,
      generatedAt: new Date().toISOString(),
    };
  }

  async recentAuditLogs(limit = 50) {
    const db = getDb();
    const rows = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
    return rows.map((r) => ({
      id: r.id,
      actorUserId: r.actorUserId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt,
    }));
  }

  async listProviderAppConfigs(): Promise<{ configs: ProviderAppConfigDto[] }> {
    const result = await getPool().query<{
      id: string;
      platform_id: string;
      platform_slug: string;
      environment: string;
      client_id: string;
      client_secret_encrypted: string | null;
      redirect_uri: string;
      enabled: boolean;
      metadata: Record<string, unknown> | null;
      updated_at: Date;
    }>(
      `
        SELECT pac.id, pac.platform_id, p.slug AS platform_slug, pac.environment,
               pac.client_id, pac.client_secret_encrypted, pac.redirect_uri,
               pac.enabled, pac.metadata, pac.updated_at
        FROM provider_app_configurations pac
        JOIN platforms p ON p.id = pac.platform_id
        ORDER BY p.slug ASC, pac.environment ASC
      `,
    );
    return {
      configs: result.rows.map((row) => ({
        id: row.id,
        platformId: row.platform_id,
        platformSlug: row.platform_slug,
        environment: row.environment,
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        enabled: row.enabled,
        clientSecretConfigured: !!row.client_secret_encrypted,
        metadata: row.metadata ?? {},
        updatedAt: row.updated_at,
      })),
    };
  }

  async upsertProviderAppConfig(
    platformSlugOrId: string,
    input: {
      environment?: string;
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
      enabled?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ config: ProviderAppConfigDto }> {
    const platform = await this.resolvePlatform(platformSlugOrId);
    const environment = input.environment?.trim() || process.env.NODE_ENV || "development";
    const clientId = input.clientId?.trim();
    const redirectUri = input.redirectUri?.trim();
    if (!clientId) throw new BadRequestException("clientId is required.");
    if (!redirectUri) throw new BadRequestException("redirectUri is required.");
    const parsedRedirect = new URL(redirectUri);
    if (!["https:", "http:"].includes(parsedRedirect.protocol)) {
      throw new BadRequestException("redirectUri must be http or https.");
    }

    const existing = await getPool().query<{ id: string; client_secret_encrypted: string | null }>(
      `
        SELECT id, client_secret_encrypted
        FROM provider_app_configurations
        WHERE platform_id = $1 AND environment = $2
        LIMIT 1
      `,
      [platform.id, environment],
    );
    const configId = existing.rows[0]?.id ?? randomUUID();
    const encryptedSecret =
      input.clientSecret && input.clientSecret.length > 0
        ? encryptSecret(
            input.clientSecret,
            undefined,
            providerAppSecretAssociatedData({
              providerConfigId: configId,
              platformSlug: platform.slug,
              secretName: "clientSecret",
            }),
          )
        : (existing.rows[0]?.client_secret_encrypted ?? null);

    const result = await getPool().query<{
      id: string;
      platform_id: string;
      platform_slug: string;
      environment: string;
      client_id: string;
      client_secret_encrypted: string | null;
      redirect_uri: string;
      enabled: boolean;
      metadata: Record<string, unknown> | null;
      updated_at: Date;
    }>(
      `
        INSERT INTO provider_app_configurations (
          id, platform_id, environment, client_id, client_secret_encrypted,
          redirect_uri, enabled, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (platform_id, environment) DO UPDATE SET
          client_id = EXCLUDED.client_id,
          client_secret_encrypted = EXCLUDED.client_secret_encrypted,
          redirect_uri = EXCLUDED.redirect_uri,
          enabled = EXCLUDED.enabled,
          metadata = EXCLUDED.metadata,
          updated_at = now()
        RETURNING id, platform_id, (SELECT slug FROM platforms WHERE id = $2) AS platform_slug,
                  environment, client_id, client_secret_encrypted, redirect_uri,
                  enabled, metadata, updated_at
      `,
      [
        configId,
        platform.id,
        environment,
        clientId,
        encryptedSecret,
        redirectUri,
        input.enabled ?? true,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to persist provider app configuration");
    return {
      config: {
        id: row.id,
        platformId: row.platform_id,
        platformSlug: row.platform_slug,
        environment: row.environment,
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        enabled: row.enabled,
        clientSecretConfigured: !!row.client_secret_encrypted,
        metadata: row.metadata ?? {},
        updatedAt: row.updated_at,
      },
    };
  }

  private normalizeRoles(roleNames: Role[]): Role[] {
    const allowed = new Set<Role>(ROLES);
    const normalized: Role[] = [];
    for (const role of roleNames) {
      if (!allowed.has(role)) {
        throw new BadRequestException(`Unknown role: ${String(role)}`);
      }
      if (!normalized.includes(role)) normalized.push(role);
    }
    if (normalized.length === 0) {
      throw new BadRequestException("At least one role is required.");
    }
    return normalized;
  }

  private async resolvePlatform(slugOrId: string): Promise<{ id: string; slug: string }> {
    const result = await getPool().query<{ id: string; slug: string }>(
      "SELECT id, slug FROM platforms WHERE id::text = $1 OR slug = $1 LIMIT 1",
      [slugOrId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Platform not found.");
    return row;
  }

  private async assertCanRemoveOperationalPrivileges(userId: string): Promise<void> {
    const roles = await getRolesForUser(userId);
    if (roles.includes("SUPER_ADMIN")) {
      await this.assertAnotherActiveSuperAdmin(userId);
    }
    if (roles.some(isAdminRole)) {
      await this.assertAnotherActiveAdmin(userId);
    }
  }

  private async assertAnotherActiveSuperAdmin(userId: string): Promise<void> {
    const count = await this.countOtherActiveUsersWithRoles(userId, ["SUPER_ADMIN"]);
    if (count < 1) {
      throw new ForbiddenException("Cannot remove the final active SUPER_ADMIN.");
    }
  }

  private async assertAnotherActiveAdmin(userId: string): Promise<void> {
    const count = await this.countOtherActiveUsersWithRoles(userId, ["ADMIN", "SUPER_ADMIN"]);
    if (count < 1) {
      throw new ForbiddenException("Cannot remove the final active administrator.");
    }
  }

  private async countOtherActiveUsersWithRoles(userId: string, roleNames: Role[]): Promise<number> {
    const pool = getPool();
    const result = await pool.query<{ count: number }>(
      `SELECT count(DISTINCT users.id)::int AS count
       FROM users
       INNER JOIN user_roles ON user_roles.user_id = users.id
       WHERE users.id <> $1
         AND users.status = 'ACTIVE'
         AND user_roles.role_name = ANY($2::role_name[])`,
      [userId, roleNames],
    );
    return result.rows[0]?.count ?? 0;
  }
}
