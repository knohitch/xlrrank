import { Global, Module } from "@nestjs/common";
import { SessionService } from "../auth/session.service.js";
import { SessionAuthGuard } from "../common/guards/session-auth.guard.js";
import { PermissionsGuard } from "../common/guards/permissions.guard.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import { AuthRateLimitService } from "./rate-limiter.js";

@Global()
@Module({
  providers: [
    SessionService,
    SessionAuthGuard,
    PermissionsGuard,
    RolesGuard,
    {
      provide: AuthRateLimitService,
      useFactory: () => new AuthRateLimitService(),
    },
  ],
  exports: [SessionService, SessionAuthGuard, PermissionsGuard, RolesGuard, AuthRateLimitService],
})
export class SecurityModule {}
