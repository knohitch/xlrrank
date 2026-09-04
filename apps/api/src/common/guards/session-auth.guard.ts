import type {
  CanActivate,
  ExecutionContext} from "@nestjs/common";
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { getRolesForUser, getDb } from "@xlrrank/database";
import { users } from "@xlrrank/database/schema";
import { eq } from "drizzle-orm";
import type { SessionService } from "../../auth/session.service.js";
import { SESSION_COOKIE, parseCookies } from "../cookies.js";
import { IS_PUBLIC_KEY } from "../decorators/roles.decorator.js";
import type { AuthContext } from "../types/auth-context.js";

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly sessionService: SessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      auth?: AuthContext;
    }>();

    const cookies = parseCookies(
      (request.headers.cookie as string | undefined) ?? undefined,
    );
    const rawToken = cookies[SESSION_COOKIE];
    if (!rawToken) {
      throw new UnauthorizedException("Not authenticated.");
    }

    const session = await this.sessionService.validate(rawToken);
    if (!session) {
      throw new UnauthorizedException("Session is invalid or expired.");
    }

    const db = getDb();
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    const user = rows[0];
    if (!user) {
      throw new UnauthorizedException("Account no longer exists.");
    }

    const status = user.status as string;
    if (status === "SUSPENDED" || status === "DISABLED") {
      throw new ForbiddenException("Account is suspended or disabled.");
    }
    if (status === "DELETION_PENDING") {
      throw new ForbiddenException("Account deletion is in progress.");
    }

    const roles = await getRolesForUser(user.id);

    request.auth = {
      userId: user.id,
      sessionId: session.sessionId,
      email: user.email,
      roles,
      status,
    };
    return true;
  }
}
