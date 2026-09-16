export interface SearchQuery {
  text: string;
  filters?: {
    entityTypes?: string[];
    platforms?: string[];
    topics?: string[];
    dateRange?: { from?: string; to?: string };
    includeDeleted?: boolean;
  };
  cursor?: string;
  pageSize?: number;
}

export interface SearchResult {
  entityType: string;
  entityId: string;
  name: string;
  description: string;
  relevanceScore: number;
  evidence: string[];
  metadata: Record<string, unknown>;
  provenance: {
    tenantId?: string;
    platform?: string;
    updatedAt?: string;
  };
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total: number;
  nextCursor?: string;
  explanation: string;
}

export interface SearchEntity {
  type: string;
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  tenantId?: string;
  platform?: string;
  topics?: string[];
  updatedAt?: string;
  deleted?: boolean;
  visibility?: "PUBLIC" | "TENANT" | "PRIVATE" | "DELETED";
}

export function buildSearchIndex(entities: SearchEntity[]): Map<string, SearchEntity[]> {
  const index = new Map<string, SearchEntity[]>();

  for (const entity of entities) {
    const words = [
      ...tokenize(entity.name),
      ...tokenize(entity.description ?? ""),
      ...(entity.tags?.flatMap(tokenize) ?? []),
      ...(entity.topics?.flatMap(tokenize) ?? []),
    ].filter((w) => w.length > 1);

    for (const word of new Set(words)) {
      if (!index.has(word)) index.set(word, []);
      index.get(word)!.push(entity);
    }
  }

  return index;
}

export function search(
  query: SearchQuery,
  index: Map<string, SearchEntity[]>,
  options?: {
    limit?: number;
    maxPageSize?: number;
    maxQueryLength?: number;
    tenantId?: string;
    userId?: string;
  },
): SearchResponse {
  const maxQueryLength = options?.maxQueryLength ?? 256;
  if (query.text.length > maxQueryLength)
    throw new Error(`Search query exceeds maximum length of ${maxQueryLength}`);
  const pageSize = clampPageSize(
    query.pageSize ?? options?.limit ?? 20,
    options?.maxPageSize ?? 50,
  );
  const queryWords = tokenize(query.text).filter((w) => w.length > 1);
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const binding = cursorBinding(query, options);
  if (cursor && cursor.binding !== binding)
    throw new Error("Search cursor is not valid for this query, filters, tenant, or user");
  const scored = new Map<string, { entity: SearchEntity; score: number }>();

  const words = queryWords.length > 0 ? queryWords : ["__all__"];
  for (const word of words) {
    const matches = index.get(word) ?? [];
    for (const match of matches) {
      const key = `${match.type}:${match.id}`;
      const existing = scored.get(key);
      if (existing) {
        existing.score += 1;
      } else {
        scored.set(key, { entity: match, score: 1 });
      }
    }
  }

  const filters = query.filters;
  let results = [...scored.values()].filter(({ entity }) =>
    isAuthorizedEntity(entity, options?.tenantId),
  );

  if (filters?.entityTypes) {
    results = results.filter((r) => filters.entityTypes!.includes(r.entity.type));
  }
  if (filters?.platforms) {
    results = results.filter(
      (r) => r.entity.platform && filters.platforms!.includes(r.entity.platform),
    );
  }
  if (filters?.topics) {
    const wanted = new Set(filters.topics.map((topic) => topic.toLocaleLowerCase()));
    results = results.filter((r) =>
      (r.entity.topics ?? []).some((topic) => wanted.has(topic.toLocaleLowerCase())),
    );
  }
  if (filters?.dateRange) {
    const from = filters.dateRange.from
      ? parseTimestamp(filters.dateRange.from, "dateRange.from").getTime()
      : undefined;
    const to = filters.dateRange.to
      ? parseTimestamp(filters.dateRange.to, "dateRange.to").getTime()
      : undefined;
    if (from !== undefined && to !== undefined && from > to)
      throw new Error("dateRange.from must be before dateRange.to");
    results = results.filter((r) => {
      if (!r.entity.updatedAt) return false;
      const updatedAt = parseTimestamp(r.entity.updatedAt, "entity.updatedAt").getTime();
      return (from === undefined || updatedAt >= from) && (to === undefined || updatedAt <= to);
    });
  }
  if (!filters?.includeDeleted) {
    results = results.filter((r) => !r.entity.deleted && r.entity.visibility !== "DELETED");
  }

  const maxScore = Math.max(1, queryWords.length);
  const searchResults: SearchResult[] = results
    .map((r) => ({
      entityType: r.entity.type,
      entityId: r.entity.id,
      name: r.entity.name,
      description: r.entity.description ?? "",
      relevanceScore: Math.round((r.score / maxScore) * 100),
      evidence: [`Matched ${r.score}/${maxScore} query terms`],
      metadata: sanitizeMetadata(r.entity.metadata ?? {}),
      provenance: {
        ...(r.entity.tenantId ? { tenantId: r.entity.tenantId } : {}),
        ...(r.entity.platform ? { platform: r.entity.platform } : {}),
        ...(r.entity.updatedAt ? { updatedAt: r.entity.updatedAt } : {}),
      },
    }))
    .sort(
      (a, b) =>
        b.relevanceScore - a.relevanceScore ||
        a.entityType.localeCompare(b.entityType) ||
        a.name.localeCompare(b.name) ||
        a.entityId.localeCompare(b.entityId),
    );

  const offset = cursor?.offset ?? 0;
  const page = searchResults.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  const nextCursor =
    nextOffset < searchResults.length ? encodeCursor({ binding, offset: nextOffset }) : undefined;

  const response: SearchResponse = {
    query: query.text,
    results: page,
    total: searchResults.length,
    explanation: `Found ${searchResults.length} results matching "${query.text}"`,
  };
  if (nextCursor) response.nextCursor = nextCursor;
  return response;
}

function tokenize(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isAuthorizedEntity(entity: SearchEntity, tenantId?: string): boolean {
  if (entity.deleted || entity.visibility === "DELETED") return false;
  if (entity.visibility === "PUBLIC" && !entity.tenantId) return true;
  return Boolean(tenantId && entity.tenantId === tenantId);
}

function clampPageSize(pageSize: number, maxPageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize < 1)
    throw new Error("pageSize must be a positive integer");
  return Math.min(pageSize, maxPageSize);
}

function cursorBinding(
  query: SearchQuery,
  options?: { tenantId?: string; userId?: string },
): string {
  return JSON.stringify({
    text: query.text.normalize("NFKC").toLocaleLowerCase(),
    filters: query.filters ?? {},
    tenantId: options?.tenantId ?? null,
    userId: options?.userId ?? null,
  });
}

function encodeCursor(cursor: { binding: string; offset: number }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): { binding: string; offset: number } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      binding?: unknown;
      offset?: unknown;
    };
    const offset = parsed.offset;
    if (
      typeof parsed.binding !== "string" ||
      typeof offset !== "number" ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      throw new Error("invalid cursor shape");
    }
    return { binding: parsed.binding, offset };
  } catch {
    throw new Error("Invalid search cursor");
  }
}

function parseTimestamp(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return parsed;
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const blocked = new Set([
    "credentials",
    "credentialsEncrypted",
    "accessToken",
    "refreshToken",
    "password",
    "secret",
    "rawProviderPayload",
  ]);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !blocked.has(key)));
}
