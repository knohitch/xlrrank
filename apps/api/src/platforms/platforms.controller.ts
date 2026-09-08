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
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
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

  @Post(":id/oauth/start")
  async oauthStart(
    @Param("id") id: string,
    @CurrentUser() auth: AuthContext,
    @Body()
    body: {
      scopeType?: "PERSONAL" | "ORGANIZATION";
      organizationId?: string;
      redirectTo?: string;
      requestedScopes?: string[];
    },
  ) {
    return this.platformsService.startOAuth(id, auth.userId, body ?? {});
  }

  @Get(":id/oauth/callback")
  async oauthCallback(
    @Param("id") id: string,
    @CurrentUser() auth: AuthContext,
    @Query("state") state: string | undefined,
    @Query("code") code: string | undefined,
    @Query("error") error: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    const callback: {
      state?: string;
      code?: string;
      error?: string;
      errorDescription?: string;
    } = {};
    if (state !== undefined) callback.state = state;
    if (code !== undefined) callback.code = code;
    if (error !== undefined) callback.error = error;
    if (errorDescription !== undefined) callback.errorDescription = errorDescription;
    const result = await this.platformsService.handleOAuthCallback(id, auth.userId, callback);
    return res.redirect(303, result.redirectTo);
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
