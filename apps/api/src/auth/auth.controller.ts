import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { getEnv } from "@xlrrank/config";
import { AuthService } from "./auth.service.js";
import { SessionService } from "./session.service.js";
import { SessionAuthGuard } from "../common/guards/session-auth.guard.js";
import { RequirePermissions } from "../common/decorators/permissions.decorator.js";
import { Public } from "../common/decorators/roles.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import type { AuthContext } from "../common/types/auth-context.js";
import { AuthRateLimitService } from "../common/rate-limiter.js";
import type { RateLimitOperation } from "../common/rate-limiter.js";
import {
  SESSION_COOKIE,
  CSRF_COOKIE,
  getCookieConfig,
  setCookie,
  clearCookie,
  parseCookies,
  generateCsrfToken,
} from "../common/cookies.js";
import { PERMISSIONS } from "@xlrrank/auth";
// DTO classes must remain runtime imports so ValidationPipe can read Nest metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  SignupDto,
  SigninDto,
  VerifyEmailDto,
  ResendVerificationDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
} from "./dto/auth.dto.js";

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService)
    private readonly authService: AuthService,
    @Inject(SessionService)
    private readonly sessionService: SessionService,
    @Inject(AuthRateLimitService)
    private readonly rateLimits: AuthRateLimitService,
  ) {}

  @Public()
  @Get("csrf")
  async csrf(@Res({ passthrough: true }) res: Response) {
    const config = getCookieConfig(getEnv().NODE_ENV);
    const token = generateCsrfToken();
    setCookie(res, CSRF_COOKIE, token, {
      ...config,
      secure: config.secure,
      httpOnly: false,
      sameSite: config.sameSite,
      maxAge: 60 * 60 * 24,
    });
    return { csrfToken: token };
  }

  @Public()
  @Post("signup")
  async signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.enforceRateLimit(res, "signup", dto.email, req.ip);
    return this.authService.signup(dto, req.ip, req.headers["user-agent"]?.toString());
  }

  @Public()
  @Post("signin")
  @HttpCode(HttpStatus.OK)
  async signin(
    @Body() dto: SigninDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? "unknown";
    await this.enforceRateLimit(res, "signin", dto.email, ip);

    const session = await this.authService.signin(dto, ip, req.headers["user-agent"]?.toString());

    const config = getCookieConfig(getEnv().NODE_ENV);
    setCookie(res, SESSION_COOKIE, session.token, {
      ...config,
      httpOnly: true,
      maxAge: getEnv().SESSION_MAX_AGE_DAYS * 24 * 60 * 60,
    });
    return { ok: true };
  }

  @Public()
  @Post("verify-email")
  @HttpCode(HttpStatus.OK)
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.enforceRateLimit(res, "verify-email", dto.token, req.ip);
    await this.authService.verifyEmail(dto.token, req.ip);
    return { message: "Email verified. You can now sign in." };
  }

  @Public()
  @Post("resend-verification")
  @HttpCode(HttpStatus.OK)
  async resendVerification(
    @Body() dto: ResendVerificationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.enforceRateLimit(res, "resend-verification", dto.email, req.ip);
    await this.authService.resendVerification(dto.email);
    return { message: "If the account exists, a verification email has been sent." };
  }

  @Public()
  @Post("forgot-password")
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.enforceRateLimit(res, "forgot-password", dto.email, req.ip);
    await this.authService.forgotPassword(dto.email);
    return {
      message: "If the email exists, a password reset link has been sent.",
    };
  }

  @Public()
  @Post("reset-password")
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.enforceRateLimit(res, "reset-password", dto.token, req.ip);
    await this.authService.resetPassword(dto.token, dto.password);
    return { message: "Password reset. You can now sign in." };
  }

  @UseGuards(SessionAuthGuard)
  @Post("signout")
  @HttpCode(HttpStatus.OK)
  async signout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookies = parseCookies(req.headers.cookie ?? undefined);
    const raw = cookies[SESSION_COOKIE];
    const config = getCookieConfig(getEnv().NODE_ENV);
    clearCookie(res, SESSION_COOKIE, config);
    if (raw) {
      const validated = await this.sessionService.validate(raw);
      if (validated) {
        await this.authService.signout(validated.sessionId);
      }
    }
    return { message: "Signed out." };
  }

  @UseGuards(SessionAuthGuard)
  @Get("me")
  async me(@CurrentUser() auth: AuthContext) {
    return { user: auth };
  }

  @UseGuards(SessionAuthGuard)
  @RequirePermissions(PERMISSIONS.PROFILE_UPDATE)
  @Post("change-password")
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(@CurrentUser() auth: AuthContext, @Body() dto: ChangePasswordDto) {
    await this.authService.changePassword(
      auth.userId,
      dto.currentPassword,
      dto.newPassword,
      auth.sessionId,
    );
  }

  @UseGuards(SessionAuthGuard)
  @Post("delete-account")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAccount(@CurrentUser() auth: AuthContext, @Body() dto: { password: string }) {
    await this.authService.deleteAccount(auth.userId, dto.password);
  }

  @UseGuards(SessionAuthGuard)
  @Get("sessions")
  async sessions(@CurrentUser() auth: AuthContext) {
    const items = await this.authService.listSessions(auth.userId, auth.sessionId);
    return { sessions: items };
  }

  @UseGuards(SessionAuthGuard)
  @Delete("sessions/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSession(@CurrentUser() auth: AuthContext, @Param("id") id: string) {
    await this.authService.revokeSession(id, auth.userId);
  }

  private async enforceRateLimit(
    res: Response,
    operation: RateLimitOperation,
    identity: string,
    ip?: string,
  ): Promise<void> {
    const result = await this.rateLimits.consume(operation, [identity, ip]);
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      throw new HttpException("Too many requests. Try again later.", HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
