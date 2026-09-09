import type {
  CanActivate,
  ExecutionContext} from "@nestjs/common";
import {
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "../decorators/roles.decorator.js";
import {
  CSRF_COOKIE,
  parseCookies,
} from "../cookies.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Double-submit-cookie CSRF protection. For unsafe methods the caller must
 * send an `X-CSRF-Token` header that matches the `xlr_csrf` cookie value.
 * This complements SameSite cookie policy. GET/HEAD/OPTIONS are exempt.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      method: string;
      headers: Record<string, string | string[] | undefined>;
    }>();

    if (!UNSAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }

    const cookies = parseCookies(
      (request.headers.cookie as string | undefined) ?? undefined,
    );
    const cookieToken = cookies[CSRF_COOKIE];
    const headerToken =
      typeof request.headers["x-csrf-token"] === "string"
        ? request.headers["x-csrf-token"]
        : undefined;

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      throw new ForbiddenException("CSRF token mismatch.");
    }
    return true;
  }
}
