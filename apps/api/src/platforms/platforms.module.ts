import { Module } from "@nestjs/common";
import { PlatformsService } from "./platforms.service.js";
import { PlatformsController } from "./platforms.controller.js";

@Module({
  controllers: [PlatformsController],
  providers: [PlatformsService],
  exports: [PlatformsService],
})
export class PlatformsModule {}
