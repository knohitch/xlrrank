import { Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
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
   * Validates a raw token for the given purpose. On success the token is
   * atomically consumed (marked used) so it can only be redeemed once.
   */
  async verifyAndConsume(
    rawToken: string,
    purpose: string,
  ): Promise<{ userId: string; tokenId: string } | null> {
    const db = getDb();
    const hash = tokenHash(rawToken);
    const rows = await db
      .select()
      .from(emailTokens)
      .where(and(eq(emailTokens.tokenHash, hash), eq(emailTokens.purpose, purpose)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.consumedAt) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;

    await db
      .update(emailTokens)
      .set({ consumedAt: new Date() })
      .where(eq(emailTokens.id, row.id));

    return { userId: row.userId, tokenId: row.id };
  }

  async revokeAllForUser(userId: string, purpose: string): Promise<void> {
    const db = getDb();
    await db
      .update(emailTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose), isNull(emailTokens.consumedAt)),
      );
  }
}
