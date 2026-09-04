import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthContext } from "../types/auth-context.js";

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const request = ctx.switchToHttp().getRequest<{ auth: AuthContext }>();
    return request.auth;
  },
);
