export interface SearchQuery {
  text: string;
  filters?: {
    entityTypes?: string[];
    platforms?: string[];
    dateRange?: { from?: string; to?: string };
  };
}

export interface SearchResult {
  entityType: string;
  entityId: string;
  name: string;
  description: string;
  relevanceScore: number;
  evidence: string[];
  metadata: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total: number;
  explanation: string;
}

export function buildSearchIndex(
  entities: Array<{
    type: string;
    id: string;
    name: string;
    description?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }>,
): Map<string, Array<{ type: string; id: string; name: string; description: string; tags: string[] }>> {
  const index = new Map<string, Array<{ type: string; id: string; name: string; description: string; tags: string[] }>>();

  for (const entity of entities) {
    const words = [
      ...entity.name.toLowerCase().split(/\s+/),
      ...(entity.description?.toLowerCase().split(/\s+/) ?? []),
      ...(entity.tags?.map((t) => t.toLowerCase()) ?? []),
    ].filter((w) => w.length > 2);

    for (const word of new Set(words)) {
      if (!index.has(word)) index.set(word, []);
      index.get(word)!.push({
        type: entity.type,
        id: entity.id,
        name: entity.name,
        description: entity.description ?? "",
        tags: entity.tags ?? [],
      });
    }
  }

  return index;
}

export function search(
  query: SearchQuery,
  index: Map<string, Array<{ type: string; id: string; name: string; description: string; tags: string[] }>>,
  options?: { limit?: number },
): SearchResponse {
  const queryWords = query.text.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const scored = new Map<string, { entity: { type: string; id: string; name: string; description: string; tags: string[] }; score: number }>();

  for (const word of queryWords) {
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
  let results = [...scored.values()];

  if (filters?.entityTypes) {
    results = results.filter((r) => filters.entityTypes!.includes(r.entity.type));
  }

  const maxScore = Math.max(1, queryWords.length);
  const searchResults: SearchResult[] = results
    .map((r) => ({
      entityType: r.entity.type,
      entityId: r.entity.id,
      name: r.entity.name,
      description: r.entity.description,
      relevanceScore: Math.round((r.score / maxScore) * 100),
      evidence: [`Matched ${r.score}/${maxScore} query terms`],
      metadata: {},
    }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, options?.limit ?? 20);

  return {
    query: query.text,
    results: searchResults,
    total: searchResults.length,
    explanation: `Found ${searchResults.length} results matching "${query.text}"`,
  };
}
