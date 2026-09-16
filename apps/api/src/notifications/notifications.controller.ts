import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { SessionAuthGuard } from "../common/guards/session-auth.guard.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import type { AuthContext } from "../common/types/auth-context.js";
import { NotificationsService } from "./notifications.service.js";

@Controller("notifications")
@UseGuards(SessionAuthGuard)
export class NotificationsController {
  constructor(
    @Inject(NotificationsService)
    private readonly notificationsService: NotificationsService,
  ) {}

  @Get()
  async list(
    @CurrentUser() auth: AuthContext,
    @Query("unreadOnly") unreadOnly?: string,
    @Query("limit") limit?: string,
  ) {
    const opts: { unreadOnly?: boolean; limit?: number } = {};
    if (unreadOnly === "true") opts.unreadOnly = true;
    if (limit !== undefined) {
      const parsed = Number(limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new BadRequestException("limit must be an integer between 1 and 100.");
      }
      opts.limit = parsed;
    }
    return {
      notifications: await this.notificationsService.list(auth.userId, opts),
    };
  }

  @Get("count")
  async count(@CurrentUser() auth: AuthContext) {
    return { count: await this.notificationsService.unreadCount(auth.userId) };
  }

  @Post(":id/read")
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(@Param("id") id: string, @CurrentUser() auth: AuthContext) {
    await this.notificationsService.markRead(id, auth.userId);
  }

  @Post("read-all")
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAllRead(@CurrentUser() auth: AuthContext) {
    await this.notificationsService.markAllRead(auth.userId);
  }
}
