import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import { getDb, getPool } from "@xlrrank/database";
import { auditLogs, users, userRoles, roles } from "@xlrrank/database/schema";
import { getRolesForUser } from "@xlrrank/database";
import { ROLES, isAdminRole, type Role } from "@xlrrank/auth";

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
