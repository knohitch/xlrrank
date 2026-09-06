import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { SessionAuthGuard } from "../common/guards/session-auth.guard.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import type { AuthContext } from "../common/types/auth-context.js";
import { PlatformsService } from "./platforms.service.js";

@Controller("platforms")
@UseGuards(SessionAuthGuard)
export class PlatformsController {
  constructor(
    @Inject(PlatformsService)
    private readonly platformsService: PlatformsService,
  ) {}

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

  @Post("connections/:connectionId/sync")
  @HttpCode(HttpStatus.ACCEPTED)
  async syncConnection(
    @Param("connectionId") connectionId: string,
    @CurrentUser() auth: AuthContext,
    @Body() body: { idempotencyKey?: string },
  ) {
    return this.platformsService.requestConnectionSync(
      connectionId,
      auth.userId,
      body?.idempotencyKey,
    );
  }

  @Get("sync-jobs/:jobId")
  async getSyncJob(@Param("jobId") jobId: string, @CurrentUser() auth: AuthContext) {
    return this.platformsService.getSyncJobStatus(jobId, auth.userId);
  }

  @Post("sync-jobs/:jobId/retry")
  @HttpCode(HttpStatus.ACCEPTED)
  async retrySyncJob(@Param("jobId") jobId: string, @CurrentUser() auth: AuthContext) {
    return this.platformsService.retrySyncJob(jobId, auth.userId);
  }
}
