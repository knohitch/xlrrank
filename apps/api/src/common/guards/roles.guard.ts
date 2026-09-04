import type {
  CanActivate,
  ExecutionContext} from "@nestjs/common";
import {
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Role } from "@xlrrank/auth";
import { ROLES_KEY } from "../decorators/roles.decorator.js";
import type { AuthContext } from "../types/auth-context.js";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ auth: AuthContext }>();
    const auth = request.auth;
    if (!auth) {
      throw new ForbiddenException("Role check requires authentication.");
    }

    const allowed = required.some((role) => auth.roles.includes(role));
    if (!allowed) {
      throw new ForbiddenException("Insufficient role.");
    }
    return true;
  }
}
