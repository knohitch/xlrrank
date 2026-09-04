import { Injectable } from "@nestjs/common";
import { getDb } from "@xlrrank/database";
import { auditLogs } from "@xlrrank/database/schema";
import { createChildLogger } from "@xlrrank/observability";

export interface AuditRecord {
  actorUserId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class AuditService {
  private readonly logger = createChildLogger("audit");

  async record(record: AuditRecord): Promise<void> {
    try {
      const db = getDb();
      await db.insert(auditLogs).values({
        actorUserId: record.actorUserId ?? null,
        action: record.action,
        entityType: record.entityType ?? null,
        entityId: record.entityId ?? null,
        ipAddress: record.ipAddress ?? null,
        metadata: (record.metadata as object) ?? null,
      });
    } catch (err) {
      // Audit failures must never break the primary operation.
      this.logger.error(
        { err: (err as Error).message, action: record.action },
        "Failed to write audit log",
      );
    }
  }
}
