import type {
  CanActivate,
  ExecutionContext} from "@nestjs/common";
import {
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
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
  canActivate(context: ExecutionContext): boolean {
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
