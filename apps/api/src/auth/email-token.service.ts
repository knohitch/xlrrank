import { Injectable } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@xlrrank/database";
import { emailTokens } from "@xlrrank/database/schema";
import { generateRandomToken, tokenHash } from "@xlrrank/auth";

export const EMAIL_TOKEN_VERIFY = "verify_email";
export const EMAIL_TOKEN_RESET = "reset_password";

@Injectable()
export class EmailTokenService {
  async create(
    userId: string,
    purpose: string,
    expiryMinutes: number,
  ): Promise<string> {
    const db = getDb();
    const raw = generateRandomToken(32);
    await db.insert(emailTokens).values({
      userId,
      purpose,
      tokenHash: tokenHash(raw),
      expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000),
    });
    return raw;
  }

  /**
   * Atomically consumes a valid token. The conditional UPDATE is the
   * single-use gate, preventing concurrent redemption of the same token.
   */
  async verifyAndConsume(
    rawToken: string,
    purpose: string,
  ): Promise<{ userId: string; tokenId: string } | null> {
    const db = getDb();
    const hash = tokenHash(rawToken);
    const now = new Date();

    const consumed = await db
      .update(emailTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(emailTokens.tokenHash, hash),
          eq(emailTokens.purpose, purpose),
          isNull(emailTokens.consumedAt),
          gt(emailTokens.expiresAt, now),
        ),
      )
      .returning({
        userId: emailTokens.userId,
        tokenId: emailTokens.id,
      });

    return consumed[0] ?? null;
  }

  async revokeAllForUser(userId: string, purpose: string): Promise<void> {
    const db = getDb();
    await db
      .update(emailTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(emailTokens.userId, userId),
          eq(emailTokens.purpose, purpose),
          isNull(emailTokens.consumedAt),
        ),
      );
  }
}
