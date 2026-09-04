import { Injectable } from "@nestjs/common";
import { getEnv } from "@xlrrank/config";
import { createChildLogger } from "@xlrrank/observability";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

class ConsoleEmailTransport implements EmailTransport {
  readonly name = "console";
  private readonly logger = createChildLogger("email-console");

  async send(message: EmailMessage): Promise<void> {
    this.logger.info(
      {
        to: message.to,
        subject: message.subject,
      },
      `[email://console] ${message.subject} -> ${message.to}`,
    );
    if (getEnv().NODE_ENV !== "production") {
      this.logger.info(
        { body: message.text },
        `[email://console] body preview`,
      );
    }
  }
}

class SmtpEmailTransport implements EmailTransport {
  readonly name = "smtp";

  private fromEmail = "";

  constructor() {
    const env = getEnv();
    this.fromEmail = env.SMTP_FROM ?? "";
  }

  async send(message: EmailMessage): Promise<void> {
    // SMTP transport requires credentials. Until SMTP_HOST/PORT/USER/PASS
    // and SMTP_FROM are configured, this transport reports UNAVAILABLE and
    // does not send. Verified via availability() at build time.
    if (!process.env.SMTP_HOST) {
      throw new Error(
        "SMTP transport is unconfigured (missing SMTP_HOST/SMTP_FROM). " +
          "Email is delivered to the console transport instead.",
      );
    }
    const { default: nodemailer } = await import("nodemailer");
    const env = getEnv();
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth:
        env.SMTP_USER && env.SMTP_PASS
          ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
          : undefined,
    });
    await transporter.sendMail({
      from: this.fromEmail,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

@Injectable()
export class EmailService {
  private readonly logger = createChildLogger("email");
  private readonly transport: EmailTransport;

  constructor() {
    const env = getEnv();
    if (
      env.EMAIL_TRANSPORT === "smtp" &&
      process.env.SMTP_HOST &&
      env.SMTP_FROM
    ) {
      this.transport = new SmtpEmailTransport();
      this.logger.info({ transport: "smtp" }, "Email transport configured");
    } else {
      this.transport = new ConsoleEmailTransport();
      if (env.EMAIL_TRANSPORT === "smtp") {
        this.logger.warn(
          "SMTP transport requested but not configured; falling back to console transport.",
        );
      }
    }
  }

  getTransportName(): string {
    return this.transport.name;
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.transport.send(message);
    } catch (err) {
      // Never leak email content; log transport error only.
      this.logger.error(
        { err: (err as Error).message, to: message.to },
        "Email delivery failed",
      );
      throw err;
    }
  }
}
