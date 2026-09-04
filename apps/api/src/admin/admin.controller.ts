import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { IsEnum, IsString } from "class-validator";
import { SessionAuthGuard } from "../common/guards/session-auth.guard.js";
import { PermissionsGuard } from "../common/guards/permissions.guard.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import { RequirePermissions } from "../common/decorators/permissions.decorator.js";
import { RequireRoles } from "../common/decorators/roles.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import type { AuthContext } from "../common/types/auth-context.js";
import { PERMISSIONS, type Role } from "@xlrrank/auth";
import type { AdminService } from "./admin.service.js";
import type { AuditService } from "../audit/audit.service.js";

const VALID_STATUSES = [
  "ACTIVE",
  "PENDING_VERIFICATION",
  "SUSPENDED",
  "DISABLED",
  "DELETION_PENDING",
] as const;

class SetStatusDto {
  @IsEnum(VALID_STATUSES)
  status!: (typeof VALID_STATUSES)[number];
}

class SetRolesDto {
  @IsString({ each: true })
  roles!: Role[];
}

@Controller("admin")
@UseGuards(SessionAuthGuard, PermissionsGuard, RolesGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly audit: AuditService,
  ) {}

  @Get("dashboard")
  @RequirePermissions(PERMISSIONS.ADMIN_USERS_READ)
  async dashboard(@CurrentUser() auth: AuthContext) {
    await this.audit.record({
      actorUserId: auth.userId,
      action: "admin.dashboard.view",
      entityType: "admin",
    });
    return this.adminService.dashboardSummary();
  }

  @Get("roles")
  @RequirePermissions(PERMISSIONS.ADMIN_USERS_READ)
  async roles() {
    return this.adminService.listRoles();
  }

  @Get("users")
  @RequirePermissions(PERMISSIONS.ADMIN_USERS_READ)
  async listUsers(
    @Query("page") page = "1",
    @Query("pageSize") pageSize = "20",
    @Query("search") search?: string,
    @Query("status") status?: string,
  ) {
    const input: {
      page: number;
      pageSize: number;
      search?: string;
      status?: string;
    } = { page: Number(page), pageSize: Number(pageSize) };
    if (search !== undefined) input.search = search;
    if (status !== undefined) input.status = status;
    return this.adminService.listUsers(input);
  }

  @Patch("users/:id/status")
  @RequirePermissions(PERMISSIONS.ADMIN_USERS_SUSPEND)
  @HttpCode(HttpStatus.NO_CONTENT)
  async setStatus(
    @Param("id") id: string,
    @Body() body: SetStatusDto,
    @CurrentUser() auth: AuthContext,
  ) {
    await this.adminService.setUserStatus(id, body.status);
    await this.audit.record({
      actorUserId: auth.userId,
      action: "admin.user.set_status",
      entityType: "user",
      entityId: id,
      metadata: { status: body.status },
    });
  }

  @Put("users/:id/roles")
  @RequireRoles("SUPER_ADMIN")
  @RequirePermissions(PERMISSIONS.ADMIN_SYSTEM_MANAGE)
  async setRoles(
    @Param("id") id: string,
    @Body() body: SetRolesDto,
    @CurrentUser() auth: AuthContext,
  ) {
    const result = await this.adminService.setUserRoles(id, body.roles);
    await this.audit.record({
      actorUserId: auth.userId,
      action: "admin.user.set_roles",
      entityType: "user",
      entityId: id,
      metadata: { roles: body.roles },
    });
    return result;
  }

  @Get("audit-logs")
  @RequirePermissions(PERMISSIONS.ADMIN_SYSTEM_MANAGE)
  async auditLogs(@Query("limit") limit = "50") {
    return { logs: await this.adminService.recentAuditLogs(Number(limit)) };
  }
}
