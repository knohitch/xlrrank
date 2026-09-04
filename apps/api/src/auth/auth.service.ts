import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { getEnv } from "@xlrrank/config";
import { createChildLogger } from "@xlrrank/observability";
import type { UsersService } from "../users/users.service.js";
import type { SessionService} from "./session.service.js";
import { type SessionInfo } from "./session.service.js";
import type {
  EmailTokenService} from "./email-token.service.js";
import {
  EMAIL_TOKEN_RESET,
  EMAIL_TOKEN_VERIFY,
} from "./email-token.service.js";
import type { EmailService } from "../email/email.service.js";
import type { AuditService } from "../audit/audit.service.js";

export interface SignupInput {
  email: string;
  password: string;
  displayName: string;
}

export interface SigninInput {
  email: string;
  password: string;
}

@Injectable()
export class AuthService {
  private readonly logger = createChildLogger("auth");

  constructor(
    private readonly usersService: UsersService,
    private readonly sessions: SessionService,
    private readonly emailTokens: EmailTokenService,
    private readonly emailService: EmailService,
    private readonly audit: AuditService,
  ) {}

  async signup(input: SignupInput, ip?: string, _userAgent?: string) {
    const env = getEnv();
    const user = await this.usersService.createUser(input);

    const token = await this.emailTokens.create(
      user.id,
      EMAIL_TOKEN_VERIFY,
      env.EMAIL_VERIFY_EXPIRY_MINUTES,
    );
    await this.sendVerificationEmail(user.email, token);

    await this.audit.record({
      actorUserId: user.id,
      action: "auth.signup",
      entityType: "user",
      entityId: user.id,
      ipAddress: ip ?? null,
    });

    this.logger.info({ userId: user.id }, "User signed up");
    return {
      user: {
        ...user,
        emailVerified: false,
      },
      message: "Account created. Check your email to verify your address.",
    };
  }

  async verifyEmail(rawToken: string, ip?: string): Promise<void> {
    const result = await this.emailTokens.verifyAndConsume(
      rawToken,
      EMAIL_TOKEN_VERIFY,
    );
    if (!result) {
      throw new BadRequestException("Verification link is invalid or expired.");
    }
    await this.usersService.markEmailVerified(result.userId);
    await this.audit.record({
      actorUserId: result.userId,
      action: "auth.email_verified",
      entityType: "user",
      entityId: result.userId,
      ipAddress: ip ?? null,
    });
  }

  async resendVerification(email: string): Promise<void> {
    const env = getEnv();
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      // Prevent account enumeration.
      return;
    }
    if (user.status !== "PENDING_VERIFICATION") {
      return;
    }
    await this.emailTokens.revokeAllForUser(user.id, EMAIL_TOKEN_VERIFY);
    const token = await this.emailTokens.create(
      user.id,
      EMAIL_TOKEN_VERIFY,
      env.EMAIL_VERIFY_EXPIRY_MINUTES,
    );
    await this.sendVerificationEmail(user.email, token);
  }

  async signin(
    input: SigninInput,
    ip?: string,
    userAgent?: string,
  ): Promise<SessionInfo> {
    const user = await this.usersService.findByEmail(input.email);
    if (!user) {
      throw new UnauthorizedException("Invalid email or password.");
    }

    const passwordOk = await this.usersService.verifyPasswordForUser(
      user.id,
      input.password,
    );
    if (!passwordOk) {
      await this.audit.record({
        actorUserId: user.id,
        action: "auth.signin_failed",
        entityType: "user",
        entityId: user.id,
        ipAddress: ip ?? null,
      });
      throw new UnauthorizedException("Invalid email or password.");
    }

    const status = user.status as string;
    if (status !== "ACTIVE") {
      if (status === "PENDING_VERIFICATION") {
        throw new UnauthorizedException(
          "Please verify your email address before signing in.",
        );
      }
      throw new UnauthorizedException(
        "This account is not active. Contact support for assistance.",
      );
    }

    const session = await this.sessions.create(user.id, ip, userAgent);
    await this.usersService.recordLogin(user.id);
    await this.audit.record({
      actorUserId: user.id,
      action: "auth.signin",
      entityType: "user",
      entityId: user.id,
      ipAddress: ip ?? null,
    });
    this.logger.info({ userId: user.id }, "User signed in");
    return session;
  }

  async signout(sessionId: string): Promise<void> {
    if (!sessionId) return;
    await this.sessions.revoke(sessionId);
  }

  async forgotPassword(email: string): Promise<void> {
    const env = getEnv();
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      // Prevent account enumeration.
      return;
    }
    const status = user.status as string;
    if (status !== "ACTIVE") return;

    await this.emailTokens.revokeAllForUser(user.id, EMAIL_TOKEN_RESET);
    const token = await this.emailTokens.create(
      user.id,
      EMAIL_TOKEN_RESET,
      env.PASSWORD_RESET_EXPIRY_MINUTES,
    );
    await this.sendPasswordResetEmail(user.email, token);
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const result = await this.emailTokens.verifyAndConsume(
      rawToken,
      EMAIL_TOKEN_RESET,
    );
    if (!result) {
      throw new BadRequestException("Reset link is invalid or expired.");
    }
    await this.usersService.changePassword(result.userId, newPassword);
    await this.sessions.revokeAllForUser(result.userId);
    await this.audit.record({
      actorUserId: result.userId,
      action: "auth.password_reset",
      entityType: "user",
      entityId: result.userId,
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const ok = await this.usersService.verifyPasswordForUser(
      userId,
      currentPassword,
    );
    if (!ok) {
      throw new UnauthorizedException("Current password is incorrect.");
    }
    await this.usersService.changePassword(userId, newPassword);
    await this.audit.record({
      actorUserId: userId,
      action: "auth.change_password",
      entityType: "user",
      entityId: userId,
    });
  }

  async deleteAccount(userId: string, password: string): Promise<void> {
    const ok = await this.usersService.verifyPasswordForUser(userId, password);
    if (!ok) {
      throw new UnauthorizedException("Password is incorrect.");
    }
    await this.usersService.setStatus(userId, "DELETION_PENDING");
    await this.sessions.revokeAllForUser(userId);
    await this.audit.record({
      actorUserId: userId,
      action: "account.delete_request",
      entityType: "user",
      entityId: userId,
    });
  }

  async listSessions(userId: string, currentSessionId: string) {
    return this.sessions.listForUser(userId, currentSessionId);
  }

  async revokeSession(sessionId: string, userId: string): Promise<void> {
    await this.sessions.revokeForUser(sessionId, userId);
    await this.audit.record({
      actorUserId: userId,
      action: "auth.revoke_session",
      entityType: "session",
      entityId: sessionId,
    });
  }

  private async sendVerificationEmail(to: string, token: string) {
    const env = getEnv();
    const url = `${env.NEXT_PUBLIC_APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
    await this.emailService.send({
      to,
      subject: "Verify your XLRrank account",
      text: `Verify your email to activate your XLRrank account.\n\n${url}\n\nThis link expires in ${env.EMAIL_VERIFY_EXPIRY_MINUTES} minutes.`,
    });
  }

  private async sendPasswordResetEmail(to: string, token: string) {
    const env = getEnv();
    const url = `${env.NEXT_PUBLIC_APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await this.emailService.send({
      to,
      subject: "Reset your XLRrank password",
      text: `A password reset was requested for your account.\n\n${url}\n\nIf you did not request this, you can ignore this email. The link expires in ${env.PASSWORD_RESET_EXPIRY_MINUTES} minutes.`,
    });
  }
}
