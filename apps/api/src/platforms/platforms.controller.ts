import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { SessionAuthGuard } from "../common/guards/session-auth.guard.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import type { AuthContext } from "../common/types/auth-context.js";
import type { PlatformsService } from "./platforms.service.js";

@Controller("platforms")
@UseGuards(SessionAuthGuard)
export class PlatformsController {
  constructor(private readonly platformsService: PlatformsService) {}

  @Get()
  async list(@CurrentUser() auth: AuthContext) {
    return { platforms: await this.platformsService.listPlatforms(auth.userId) };
  }

  @Get(":id")
  async get(@Param("id") id: string, @CurrentUser() auth: AuthContext) {
    return { platform: await this.platformsService.getPlatform(id, auth.userId) };
  }

  @Post(":id/connect")
  async connect(
    @Param("id") id: string,
    @CurrentUser() auth: AuthContext,
    @Body() credentials: Record<string, unknown>,
  ) {
    return this.platformsService.connectPlatform(id, auth.userId, credentials);
  }

  @Delete(":id/disconnect")
  async disconnect(@Param("id") id: string, @CurrentUser() auth: AuthContext) {
    return this.platformsService.disconnectPlatform(id, auth.userId);
  }
}
