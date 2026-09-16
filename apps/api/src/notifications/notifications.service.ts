import { Injectable, NotFoundException } from "@nestjs/common";
import { desc, eq, and, sql } from "drizzle-orm";
import { getDb } from "@xlrrank/database";
import { notifications } from "@xlrrank/database/schema";

export type NotificationType =
  | "HIGH_VALUE_OPPORTUNITY"
  | "RELATIONSHIP_COOLING"
  | "NEW_MODEL_AVAILABLE"
  | "PLATFORM_CONNECTION_PROBLEM"
  | "PROVIDER_FAILURE"
  | "TREND_ALERT"
  | "SUPPORT_TICKET_UPDATE"
  | "SECURITY_EVENT";

@Injectable()
export class NotificationsService {
  async list(userId: string, options?: { unreadOnly?: boolean; limit?: number }) {
    const db = getDb();
    const limit = Math.min(Math.max(1, options?.limit ?? 50), 100);
    const conditions = [eq(notifications.userId, userId)];
    if (options?.unreadOnly) {
      conditions.push(eq(notifications.read, false));
    }
    return db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  async create(input: {
    userId: string;
    type: NotificationType;
    title: string;
    body?: string;
    data?: Record<string, unknown>;
  }) {
    const db = getDb();
    const inserted = await db
      .insert(notifications)
      .values({
        userId: input.userId,
        type: input.type,
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        ...(input.data ? { data: input.data } : {}),
      })
      .returning();
    return inserted[0];
  }

  async markRead(notificationId: string, userId: string) {
    const db = getDb();
    const updated = await db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
      .returning({ id: notifications.id });
    if (updated.length === 0) {
      throw new NotFoundException("Notification not found.");
    }
  }

  async markAllRead(userId: string) {
    const db = getDb();
    await db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
  }

  async unreadCount(userId: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
    return rows[0]?.count ?? 0;
  }
}
