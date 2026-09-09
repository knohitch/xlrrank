import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { SessionAuthGuard } from "../common/guards/session-auth.guard.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { CsrfExempt, Public } from "../common/decorators/roles.decorator.js";
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

  @Public()
  @Get(":id/meta/webhook")
  verifyMetaWebhook(
    @Param("id") id: string,
    @Query("hub.mode") mode: string | undefined,
    @Query("hub.verify_token") token: string | undefined,
    @Query("hub.challenge") challenge: string | undefined,
  ) {
    return this.platformsService.verifyMetaWebhookChallenge(id, { mode, token, challenge });
  }

  @Public()
  @CsrfExempt()
  @Post(":id/meta/webhook")
  @HttpCode(HttpStatus.OK)
  async receiveMetaWebhook(
    @Param("id") id: string,
    @Headers("x-hub-signature-256") signature: string | undefined,
    @Body() body: Record<string, unknown>,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    return this.platformsService.receiveMetaWebhook(id, signature, body ?? {}, req.rawBody);
  }

  @Public()
  @Get(":id/linkedin/webhook")
  verifyLinkedInWebhook(
    @Param("id") id: string,
    @Query("challengeCode") challengeCode: string | undefined,
  ) {
    return this.platformsService.verifyLinkedInWebhookChallenge(id, { challengeCode });
  }

  @Public()
  @CsrfExempt()
  @Post(":id/linkedin/webhook")
  @HttpCode(HttpStatus.OK)
  async receiveLinkedInWebhook(
    @Param("id") id: string,
    @Headers("x-li-signature") signature: string | undefined,
    @Body() body: Record<string, unknown>,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    return this.platformsService.receiveLinkedInWebhook(id, signature, body ?? {}, req.rawBody);
  }

  @Get("authorizations/:authorizationId/assets")
  async listAuthorizationAssets(
    @Param("authorizationId") authorizationId: string,
    @CurrentUser() auth: AuthContext,
  ) {
    return this.platformsService.listAuthorizationAssets(authorizationId, auth.userId);
  }

  @Post("authorizations/:authorizationId/assets/:assetId/connect")
  async connectAuthorizationAsset(
    @Param("authorizationId") authorizationId: string,
    @Param("assetId") assetId: string,
    @CurrentUser() auth: AuthContext,
  ) {
    return this.platformsService.connectAuthorizationAsset(authorizationId, assetId, auth.userId);
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
