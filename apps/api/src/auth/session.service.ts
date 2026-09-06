import { Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@xlrrank/database";
import { sessions } from "@xlrrank/database/schema";
import {
  createSessionToken,
  parseSessionToken,
  parseSignedToken,
  signToken,
  tokenHash,
  type SessionToken,
} from "@xlrrank/auth";
import { getEnv } from "@xlrrank/config";

export interface SessionInfo {
  id: string;
  token: string;
  expiresAt: Date;
}

export interface ValidatedSession {
  sessionId: string;
  userId: string;
}

export interface SessionListItem {
  id: string;
  current: boolean;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  async create(userId: string, ipAddress?: string, userAgent?: string): Promise<SessionInfo> {
    const env = getEnv();
    const db = getDb();
    const expiresAt = new Date(Date.now() + env.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    const sessionId = crypto.randomUUID();
    const token = createSessionToken(sessionId);
    const signed = signToken(`${token.sessionId}.${token.secret}`);

    await db.insert(sessions).values({
      id: sessionId,
      userId,
      tokenHash: tokenHash(token.secret),
      userAgent: userAgent ?? null,
      ipAddress: ipAddress ?? null,
      expiresAt,
    });

    return { id: sessionId, token: signed, expiresAt };
  }

  async validate(rawToken: string): Promise<ValidatedSession | null> {
    const payload = parseSignedToken(rawToken);
    if (!payload) return null;

    let token: SessionToken;
    try {
      token = parseSessionToken(payload);
    } catch {
      return null;
    }

    const db = getDb();
    const rows = await db.select().from(sessions).where(eq(sessions.id, token.sessionId)).limit(1);

    const session = rows[0];
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt.getTime() < Date.now()) return null;

    const expected = tokenHash(token.secret);
    const stored = session.tokenHash;
    if (!stored || !this.safeEqual(expected, stored)) return null;

    return { sessionId: session.id, userId: session.userId };
  }

  async listForUser(userId: string, currentSessionId: string): Promise<SessionListItem[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .orderBy(sessions.createdAt);
    return rows.map((s) => ({
      id: s.id,
      current: s.id === currentSessionId,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
    }));
  }

  async revoke(sessionId: string): Promise<void> {
    const db = getDb();
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  async revokeForUser(sessionId: string, userId: string): Promise<boolean> {
    const db = getDb();
    const updated = await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)),
      )
      .returning({ id: sessions.id });
    return updated.length > 0;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const db = getDb();
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  async revokeOtherSessionsForUser(userId: string, currentSessionId: string): Promise<void> {
    const db = getDb();
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          sql`${sessions.id} <> ${currentSessionId}`,
        ),
      );
  }

  private safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }
}
