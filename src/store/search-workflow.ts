import type { SearchResult } from "../types.js";

export type SearchDocRow = {
  doc_id: string;
  pr_number: number;
  doc_kind: "pr_body" | "comment";
  title: string;
  text: string;
  updated_at: string;
  score: number;
};

type RankedSearchDocRow = SearchDocRow & {
  vectorScore: number;
  textScore: number;
};

export function rankSearchDocRows(params: {
  keywordHits: SearchDocRow[];
  vectorHits: SearchDocRow[];
  vectorFallbackWeight: number;
}): RankedSearchDocRow[] {
  const byDoc = new Map<string, RankedSearchDocRow>();

  for (const hit of params.keywordHits) {
    byDoc.set(hit.doc_id, { ...hit, vectorScore: 0, textScore: hit.score });
  }
  for (const hit of params.vectorHits) {
    const existing = byDoc.get(hit.doc_id);
    if (existing) {
      existing.vectorScore = hit.score;
    } else {
      byDoc.set(hit.doc_id, { ...hit, vectorScore: hit.score, textScore: 0 });
    }
  }

  return Array.from(byDoc.values())
    .map((row) => ({
      ...row,
      score:
        params.keywordHits.length > 0
          ? row.textScore > 0
            ? row.textScore
            : row.vectorScore * params.vectorFallbackWeight
          : row.vectorScore,
    }))
    .sort((left, right) => right.score - left.score);
}

export function limitRelatedPullRequests(
  results: SearchResult[],
  seedPrNumber: number,
  limit: number,
): SearchResult[] {
  return results.filter((result) => result.prNumber !== seedPrNumber).slice(0, limit);
}
