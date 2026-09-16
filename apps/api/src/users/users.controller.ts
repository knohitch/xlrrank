import { Body, Controller, Get, Inject, Patch, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { SessionAuthGuard } from "../common/guards/session-auth.guard.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { RequirePermissions } from "../common/decorators/permissions.decorator.js";
import { PERMISSIONS } from "@xlrrank/auth";
import type { AuthContext } from "../common/types/auth-context.js";
import { UsersService } from "./users.service.js";
import { AuditService } from "../audit/audit.service.js";

export class UpdateProfileDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string | null;
}

@Controller("users")
@UseGuards(SessionAuthGuard)
export class UsersController {
  constructor(
    @Inject(UsersService)
    private readonly usersService: UsersService,
    @Inject(AuditService)
    private readonly audit: AuditService,
  ) {}

  @Get("me")
  async me(@CurrentUser() auth: AuthContext) {
    const user = await this.usersService.getPublicUser(auth.userId);
    return { user };
  }

  @Patch("me")
  @RequirePermissions(PERMISSIONS.PROFILE_UPDATE)
  async updateMe(@CurrentUser() auth: AuthContext, @Body() body: UpdateProfileDto) {
    const data: { displayName?: string; avatarUrl?: string | null } = {
      displayName: body.displayName,
    };
    if (body.avatarUrl !== undefined) {
      data.avatarUrl = body.avatarUrl;
    }
    const user = await this.usersService.updateProfile(auth.userId, data);
    await this.audit.record({
      actorUserId: auth.userId,
      action: "user.profile_update",
      entityType: "user",
      entityId: auth.userId,
    });
    return { user };
  }
}
