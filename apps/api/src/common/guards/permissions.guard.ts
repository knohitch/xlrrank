import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { getPermissionsForUser } from "@xlrrank/database";
import type { Permission } from "@xlrrank/auth";
import { PERMISSIONS_KEY } from "../decorators/permissions.decorator.js";
import type { AuthContext } from "../types/auth-context.js";

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ auth: AuthContext }>();
    const auth = request.auth;
    if (!auth) {
      throw new ForbiddenException("Permission check requires authentication.");
    }

    const granted = await getPermissionsForUser(auth.userId);
    const allowed = required.every((p) => granted.includes(p));
    if (!allowed) {
      throw new ForbiddenException("Insufficient permissions.");
    }
    return true;
  }
}
