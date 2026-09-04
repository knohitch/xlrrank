import { and, eq } from "drizzle-orm";
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from "@xlrrank/auth";
import { getDb } from "./client.js";
import {
  permissions,
  rolePermissions,
  roles,
  userRoles,
} from "./schema/index.js";

export async function seedRbac(): Promise<void> {
  const db = getDb();

  for (const role of Object.keys(ROLE_PERMISSIONS) as Role[]) {
    await db
      .insert(roles)
      .values({ name: role, description: `${role} role` })
      .onConflictDoNothing();
  }

  for (const key of ALL_PERMISSIONS) {
    await db
      .insert(permissions)
      .values({ key, description: key })
      .onConflictDoNothing();
  }

  const permissionRows = await db
    .select({ id: permissions.id, key: permissions.key })
    .from(permissions);

  const permissionIdByKey = new Map<string, string>(
    permissionRows.map((r) => [r.key, r.id]),
  );

  for (const role of Object.keys(ROLE_PERMISSIONS) as Role[]) {
    const granted = ROLE_PERMISSIONS[role] as Permission[];
    for (const permKey of granted) {
      const permissionId = permissionIdByKey.get(permKey);
      if (!permissionId) continue;
      await db
        .insert(rolePermissions)
        .values({ roleName: role, permissionId })
        .onConflictDoNothing();
    }
  }
}

export async function assignRole(
  userId: string,
  role: Role,
): Promise<void> {
  const db = getDb();
  await db
    .insert(userRoles)
    .values({ userId, roleName: role })
    .onConflictDoNothing();
}

export async function getRolesForUser(userId: string): Promise<Role[]> {
  const db = getDb();
  const rows = await db
    .select({ roleName: userRoles.roleName })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.roleName);
}

export async function getPermissionsForUser(userId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ key: permissions.key })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleName, userRoles.roleName))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.key);
}

export async function userHasPermission(
  userId: string,
  permission: Permission,
): Promise<boolean> {
  const perms = await getPermissionsForUser(userId);
  return perms.includes(permission) || perms.includes("*");
}

export async function assertUniqueRole(
  userId: string,
  role: Role,
): Promise<void> {
  const db = getDb();
  await db
    .delete(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.roleName, role)));
}
