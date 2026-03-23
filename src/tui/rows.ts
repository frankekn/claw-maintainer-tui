import type { TuiFreshness, TuiResultRow } from "./types.js";

export function computePrFreshness(params: {
  updatedAt: string;
  key: string;
  detailFreshness: ReadonlyMap<string, TuiFreshness>;
  now?: number;
}): TuiFreshness {
  const { updatedAt, key, detailFreshness, now = Date.now() } = params;
  const session = detailFreshness.get(key);
  if (session) {
    return session;
  }
  const ageMs = now - new Date(updatedAt).getTime();
  if (ageMs < 12 * 60 * 60 * 1000) {
    return "fresh";
  }
  if (ageMs > 7 * 24 * 60 * 60 * 1000) {
    return "stale";
  }
  return "partial";
}

export function rowFreshness(
  row: Extract<TuiResultRow, { kind: "pr" | "issue" | "priority-cluster" }>,
): TuiFreshness {
  return row.freshness;
}

export function rowIdentity(
  row: Extract<TuiResultRow, { kind: "pr" | "issue" | "priority-cluster" }>,
): string {
  if (row.kind === "pr") {
    return `pr:${row.pr.prNumber}`;
  }
  if (row.kind === "issue") {
    return `issue:${row.issue.issueNumber}`;
  }
  return row.cluster.clusterKey;
}

export function rowUrl(row: TuiResultRow | undefined): string | null {
  if (!row) {
    return null;
  }
  if (row.kind === "pr") {
    return row.pr.url;
  }
  if (row.kind === "issue") {
    return row.issue.url;
  }
  if (row.kind === "priority-cluster") {
    return row.cluster.representative.pr.url;
  }
  return null;
}

export function rowIdentityForAny(row: TuiResultRow): string | null {
  if (row.kind === "pr") {
    return `pr:${row.pr.prNumber}`;
  }
  if (row.kind === "issue") {
    return `issue:${row.issue.issueNumber}`;
  }
  if (row.kind === "priority-cluster") {
    return row.cluster.clusterKey;
  }
  return row.kind;
}

export function selectedRowIdentity(rows: TuiResultRow[], selectedIndex: number): string | null {
  const row = rows[selectedIndex];
  return row ? rowIdentityForAny(row) : null;
}
