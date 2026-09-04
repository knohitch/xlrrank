import { Injectable } from "@nestjs/common";
import { desc } from "drizzle-orm";
import { getDb } from "@xlrrank/database";
import { auditLogs } from "@xlrrank/database/schema";
import { getPool } from "@xlrrank/database";

export interface Report {
  name: string;
  description: string;
  generatedAt: string;
  data: unknown;
}

@Injectable()
export class ReportsService {
  async networkGrowthReport(userId: string): Promise<Report> {
    const db = getDb();
    const pool = getPool();

    const personCount = await pool.query<{ count: number }>(
      "SELECT count(*)::int as count FROM people",
    );

    return {
      name: "Network Growth",
      description: "Growth of tracked people and relationships over time",
      generatedAt: new Date().toISOString(),
      data: {
        totalPeople: personCount.rows[0]?.count ?? 0,
        note: "Time-series data will populate as interactions accumulate",
      },
    };
  }

  async aiUsageReport(): Promise<Report> {
    const db = getDb();
    const pool = getPool();

    const usageCount = await pool.query<{ count: number }>(
      "SELECT count(*)::int as count FROM ai_usage",
    );

    return {
      name: "AI Usage",
      description: "AI provider usage, costs, and performance",
      generatedAt: new Date().toISOString(),
      data: {
        totalRequests: usageCount.rows[0]?.count ?? 0,
        note: "Detailed breakdowns available after AI operations run",
      },
    };
  }

  async recentAuditLogs(limit = 100) {
    const db = getDb();
    return db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  }
}
