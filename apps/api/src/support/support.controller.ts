import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { SessionAuthGuard } from "../common/guards/session-auth.guard.js";
import { PermissionsGuard } from "../common/guards/permissions.guard.js";
import { RequirePermissions } from "../common/decorators/permissions.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import type { AuthContext } from "../common/types/auth-context.js";
import { PERMISSIONS } from "@xlrrank/auth";
import type { SupportService} from "./support.service.js";
import { type TicketPriority, type TicketStatus } from "./support.service.js";

function isSupportRole(auth: AuthContext): boolean {
  return auth.roles.some((r) => r === "SUPPORT" || r === "ADMIN" || r === "SUPER_ADMIN");
}

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
const STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_FOR_USER", "ESCALATED", "RESOLVED", "CLOSED"] as const;

class CreateTicketDto {
  @IsString()
  @MaxLength(60)
  subject!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  body!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsEnum(PRIORITIES)
  priority?: TicketPriority;
}

class AddMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;

  @IsOptional()
  isInternal?: boolean;
}

class UpdateTicketDto {
  @IsOptional()
  @IsEnum(STATUSES)
  status?: TicketStatus;

  @IsOptional()
  @IsEnum(PRIORITIES)
  priority?: TicketPriority;

  @IsOptional()
  @IsString()
  assignedToUserId?: string | null;
}

@Controller("support")
@UseGuards(SessionAuthGuard, PermissionsGuard)
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Post("tickets")
  async createTicket(@CurrentUser() auth: AuthContext, @Body() dto: CreateTicketDto) {
    return this.supportService.createTicket({
      userId: auth.userId,
      category: dto.category ?? null,
      priority: dto.priority ?? "MEDIUM",
      subject: dto.subject,
      body: dto.body,
    });
  }

  @Get("tickets")
  async listTickets(
    @CurrentUser() auth: AuthContext,
    @Query("status") status?: string,
  ) {
    if (isSupportRole(auth)) {
      return { tickets: await this.supportService.listAllTickets(status) };
    }
    return { tickets: await this.supportService.listOwnTickets(auth.userId) };
  }

  @Get("tickets/:id")
  async getTicket(@CurrentUser() auth: AuthContext, @Param("id") id: string) {
    return this.supportService.getTicket(id, {
      id: auth.userId,
      isSupport: isSupportRole(auth),
    });
  }

  @Post("tickets/:id/messages")
  @HttpCode(HttpStatus.CREATED)
  async addMessage(
    @CurrentUser() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: AddMessageDto,
  ) {
    const isSupport = isSupportRole(auth);
    await this.supportService.addMessage(id, { id: auth.userId, isSupport }, {
      body: dto.body,
      isInternal: dto.isInternal ?? false,
    });
    return this.supportService.getTicket(id, { id: auth.userId, isSupport });
  }

  @Patch("tickets/:id")
  @RequirePermissions(PERMISSIONS.SUPPORT_TICKET_RESPOND)
  async updateTicket(
    @CurrentUser() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: UpdateTicketDto,
  ) {
    if (!isSupportRole(auth)) {
      throw new ForbiddenException("Insufficient role.");
    }
    await this.supportService.updateTicket(id, {
      status: dto.status,
      priority: dto.priority,
      assignedToUserId: dto.assignedToUserId,
    });
    return this.supportService.getTicket(id, { id: auth.userId, isSupport: true });
  }
}
