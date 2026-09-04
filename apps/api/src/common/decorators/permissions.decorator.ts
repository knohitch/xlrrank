import { SetMetadata } from "@nestjs/common";
import type { Permission } from "@xlrrank/auth";

export const PERMISSIONS_KEY = "xlrrank:permissions";

export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
