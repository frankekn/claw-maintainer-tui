import { crossSearchLimits, currentBrowseCapacity } from "./listing.js";
import type { TuiMode, TuiResultRow } from "./types.js";

export function canLoadMoreRows(
  mode: TuiMode,
  rows: TuiResultRow[],
  browseLimit: number,
  options: { priorityScanLimit?: number } = {},
): boolean {
  switch (mode) {
    case "cross-search": {
      const limits = crossSearchLimits(browseLimit);
      const prCount = rows.filter((row) => row.kind === "pr").length;
      const issueCount = rows.filter((row) => row.kind === "issue").length;
      return prCount >= limits.pr || issueCount >= limits.issue;
    }
    case "inbox":
      return (
        rows.length >= currentBrowseCapacity(mode, browseLimit) ||
        (rows.some((row) => row.kind === "priority-cluster") &&
          browseLimit < (options.priorityScanLimit ?? browseLimit))
      );
    case "watchlist":
    case "pr-search":
    case "issue-search":
      return rows.length >= currentBrowseCapacity(mode, browseLimit);
    default:
      return false;
  }
}

export function isPriorityDetailRow(
  row: TuiResultRow | undefined,
): row is Extract<TuiResultRow, { kind: "pr" | "priority-cluster" }> {
  return row?.kind === "pr" || row?.kind === "priority-cluster";
}
