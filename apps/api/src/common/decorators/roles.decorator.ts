import { SetMetadata } from "@nestjs/common";
import type { Role } from "@xlrrank/auth";

export const ROLES_KEY = "xlrrank:roles";

export const RequireRoles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const IS_PUBLIC_KEY = "xlrrank:isPublic";

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const CSRF_EXEMPT_KEY = "xlrrank:csrfExempt";

export const CsrfExempt = () => SetMetadata(CSRF_EXEMPT_KEY, true);
