import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@xlrrank/database";
import {
  supportMessages,
  supportTickets,
} from "@xlrrank/database/schema";

const TICKET_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_FOR_USER",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

const TICKET_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUS_SET: ReadonlySet<string> = new Set(TICKET_STATUSES);
export const TICKET_PRIORITY_SET: ReadonlySet<string> = new Set(TICKET_PRIORITIES);

export interface TicketRow {
  id: string;
  userId: string;
  assignedToUserId: string | null;
  category: string | null;
  priority: string;
  status: string;
  subject: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class SupportService {
  async createTicket(input: {
    userId: string;
    category: string | null;
    priority: string;
    subject: string;
    body: string;
  }): Promise<{ ticket: TicketRow }> {
    const db = getDb();
    const inserted = await db
      .insert(supportTickets)
      .values({
        userId: input.userId,
        category: input.category,
        priority: input.priority,
        status: "OPEN",
        subject: input.subject,
      })
      .returning();
    const ticket = inserted[0];
    if (!ticket) throw new Error("Ticket creation failed.");
    await db.insert(supportMessages).values({
      ticketId: ticket.id,
      senderUserId: input.userId,
      body: input.body,
      isInternal: false,
    });
    return { ticket };
  }

  async listOwnTickets(userId: string) {
    const db = getDb();
    const rows = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.userId, userId))
      .orderBy(desc(supportTickets.createdAt));
    return rows;
  }

  async listAllTickets(status?: string) {
    const db = getDb();
    const rows = status
      ? await db
          .select()
          .from(supportTickets)
          .where(eq(supportTickets.status, status as never))
          .orderBy(desc(supportTickets.createdAt))
      : await db
          .select()
          .from(supportTickets)
          .orderBy(desc(supportTickets.createdAt));
    return rows.map((t) => this.sanitizeTicket(t));
  }

  async getTicket(ticketId: string, viewer: { id: string; isSupport: boolean }) {
    const db = getDb();
    const rows = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, ticketId))
      .limit(1);
    const ticket = rows[0];
    if (!ticket) throw new NotFoundException("Ticket not found.");
    if (!viewer.isSupport && ticket.userId !== viewer.id) {
      throw new ForbiddenException("You do not have access to this ticket.");
    }
    const messages = await db
      .select()
      .from(supportMessages)
      .where(eq(supportMessages.ticketId, ticketId))
      .orderBy(supportMessages.createdAt);
    return { ticket, messages };
  }

  async addMessage(
    ticketId: string,
    viewer: { id: string; isSupport: boolean },
    input: { body: string; isInternal: boolean },
  ) {
    const db = getDb();
    const rows = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, ticketId))
      .limit(1);
    const ticket = rows[0];
    if (!ticket) throw new NotFoundException("Ticket not found.");
    if (!viewer.isSupport && ticket.userId !== viewer.id) {
      throw new ForbiddenException("You do not have access to this ticket.");
    }
    if (input.isInternal && !viewer.isSupport) {
      throw new ForbiddenException("Only support can add internal notes.");
    }
    await db.insert(supportMessages).values({
      ticketId,
      senderUserId: viewer.id,
      body: input.body,
      isInternal: input.isInternal,
    });
    const newStatus: TicketStatus =
      viewer.isSupport && !input.isInternal ? "WAITING_FOR_USER" : "IN_PROGRESS";
    await db
      .update(supportTickets)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(supportTickets.id, ticketId));
  }

  async updateTicket(
    ticketId: string,
    input: {
      status?: TicketStatus | undefined;
      priority?: TicketPriority | undefined;
      assignedToUserId?: string | null | undefined;
    },
  ) {
    const db = getDb();
    const rows = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, ticketId))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("Ticket not found.");
    await db
      .update(supportTickets)
      .set({
        ...(input.status ? { status: input.status as never } : {}),
        ...(input.priority ? { priority: input.priority as never } : {}),
        ...(input.assignedToUserId !== undefined
          ? { assignedToUserId: input.assignedToUserId as never }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(supportTickets.id, ticketId));
    return this.getTicket(ticketId, { id: "", isSupport: true });
  }

  private sanitizeTicket(t: (typeof supportTickets.$inferSelect)) {
    return {
      id: t.id,
      category: t.category,
      priority: t.priority,
      status: t.status,
      subject: t.subject,
      assignedToUserId: t.assignedToUserId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }
}
