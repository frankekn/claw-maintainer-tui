export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((token) => token.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token.replaceAll('"', "")}"`).join(" AND ");
}

export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 1 / (1 + 999);
  }
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}
