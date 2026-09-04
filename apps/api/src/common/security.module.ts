import { Global, Module } from "@nestjs/common";
import { SessionService } from "../auth/session.service.js";
import { SessionAuthGuard } from "../common/guards/session-auth.guard.js";
import { PermissionsGuard } from "../common/guards/permissions.guard.js";
import { RolesGuard } from "../common/guards/roles.guard.js";

@Global()
@Module({
  providers: [
    SessionService,
    SessionAuthGuard,
    PermissionsGuard,
    RolesGuard,
  ],
  exports: [SessionService, SessionAuthGuard, PermissionsGuard, RolesGuard],
})
export class SecurityModule {}
