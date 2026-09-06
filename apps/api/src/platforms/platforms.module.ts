import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { PlatformsService } from "./platforms.service.js";
import { PlatformsController } from "./platforms.controller.js";

@Module({
  imports: [AuditModule],
  controllers: [PlatformsController],
  providers: [PlatformsService],
  exports: [PlatformsService],
})
export class PlatformsModule {}
