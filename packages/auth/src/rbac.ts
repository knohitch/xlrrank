export const ROLES = ["USER", "SUPPORT", "ADMIN", "SUPER_ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  PROFILE_READ: "user.profile.read",
  PROFILE_UPDATE: "user.profile.update",
  SUPPORT_TICKET_READ: "support.ticket.read",
  SUPPORT_TICKET_RESPOND: "support.ticket.respond",
  ADMIN_USERS_READ: "admin.users.read",
  ADMIN_USERS_SUSPEND: "admin.users.suspend",
  ADMIN_PROVIDERS_MANAGE: "admin.providers.manage",
  ADMIN_PLATFORMS_MANAGE: "admin.platforms.manage",
  ADMIN_SYSTEM_MANAGE: "admin.system.manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  USER: [PERMISSIONS.PROFILE_READ, PERMISSIONS.PROFILE_UPDATE],
  SUPPORT: [
    PERMISSIONS.PROFILE_READ,
    PERMISSIONS.PROFILE_UPDATE,
    PERMISSIONS.SUPPORT_TICKET_READ,
    PERMISSIONS.SUPPORT_TICKET_RESPOND,
  ],
  ADMIN: [
    PERMISSIONS.PROFILE_READ,
    PERMISSIONS.PROFILE_UPDATE,
    PERMISSIONS.SUPPORT_TICKET_READ,
    PERMISSIONS.SUPPORT_TICKET_RESPOND,
    PERMISSIONS.ADMIN_USERS_READ,
    PERMISSIONS.ADMIN_USERS_SUSPEND,
    PERMISSIONS.ADMIN_PROVIDERS_MANAGE,
    PERMISSIONS.ADMIN_PLATFORMS_MANAGE,
  ],
  SUPER_ADMIN: [
    PERMISSIONS.PROFILE_READ,
    PERMISSIONS.PROFILE_UPDATE,
    PERMISSIONS.SUPPORT_TICKET_READ,
    PERMISSIONS.SUPPORT_TICKET_RESPOND,
    PERMISSIONS.ADMIN_USERS_READ,
    PERMISSIONS.ADMIN_USERS_SUSPEND,
    PERMISSIONS.ADMIN_PROVIDERS_MANAGE,
    PERMISSIONS.ADMIN_PLATFORMS_MANAGE,
    PERMISSIONS.ADMIN_SYSTEM_MANAGE,
  ],
};

const ROLES_BY_RANK: Record<Role, number> = {
  USER: 0,
  SUPPORT: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

export function isAdminRole(role: Role): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

export function isSuperAdminRole(role: Role): boolean {
  return role === "SUPER_ADMIN";
}

export function roleRank(role: Role): number {
  return ROLES_BY_RANK[role] ?? 0;
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function roleHasAtLeast(role: Role, minimum: Role): boolean {
  return roleRank(role) >= roleRank(minimum);
}
