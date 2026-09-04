import { Module } from "@nestjs/common";
import { SecurityModule } from "./common/security.module.js";
import { AuditModule } from "./audit/audit.module.js";
import { EmailModule } from "./email/email.module.js";
import { HealthController } from "./health/health.controller.js";
import { HealthService } from "./health/health.service.js";
import { AuthModule } from "./auth/auth.module.js";
import { UsersModule } from "./users/users.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { SupportModule } from "./support/support.module.js";
import { PlatformsModule } from "./platforms/platforms.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";

@Module({
  imports: [
    SecurityModule,
    AuditModule,
    EmailModule,
    AuthModule,
    UsersModule,
    AdminModule,
    SupportModule,
    PlatformsModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
