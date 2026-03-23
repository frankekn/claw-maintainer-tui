import type {
  IssueSearchResult,
  PriorityCandidate,
  PriorityInboxItem,
  SearchResult,
} from "../types.js";
import type {
  ListLoadResult,
  ListMode,
  SearchMode,
  TuiListSummary,
  TuiResultRow,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 20;
const CROSS_SEARCH_PAGE_SIZE = {
  pr: 10,
  issue: 10,
} as const;

export function buildListSummary(params: {
  mode: ListMode | "status";
  rows: TuiResultRow[];
  browseLimit: number;
}): TuiListSummary | null {
  const { mode, rows, browseLimit } = params;
  const count = rows.length;
  if (mode === "status") {
    return { yieldLabel: `${count} metrics`, confidenceLabel: null, coverageLabel: null };
  }
  if (mode === "inbox" || mode === "watchlist") {
    const representedCount = rows.reduce((sum, row) => {
      if (row.kind === "pr") {
        return sum + 1;
      }
      if (row.kind === "priority-cluster") {
        return sum + row.cluster.totalPrCount;
      }
      return sum;
    }, 0);
    const linkedCount = rows.filter((row) => {
      if (row.kind === "pr") {
        return (row.priority?.linkedIssueCount ?? 0) > 0;
      }
      return row.kind === "priority-cluster" && row.cluster.linkedIssueCount > 0;
    }).length;
    const relatedCount = rows.filter((row) => {
      if (row.kind === "pr") {
        return (row.priority?.relatedPullRequestCount ?? 0) > 0;
      }
      return row.kind === "priority-cluster" && row.cluster.totalPrCount > 1;
    }).length;
    return {
      yieldLabel: `${count} row${count === 1 ? "" : "s"} · ${representedCount} PR${representedCount === 1 ? "" : "s"}${count >= browseLimit ? ` · ${browseLimit} shown` : ""}`,
      confidenceLabel: `issue-linked ${linkedCount} · related ${relatedCount}`,
      coverageLabel: mode === "watchlist" ? "local watch state" : "collapsed priority queue",
    };
  }

  const prRows = rows.filter(
    (row): row is Extract<TuiResultRow, { kind: "pr" }> => row.kind === "pr",
  );
  const issueRows = rows.filter(
    (row): row is Extract<TuiResultRow, { kind: "issue" }> => row.kind === "issue",
  );
  const scores = [...prRows.map((row) => row.pr.score), ...issueRows.map((row) => row.issue.score)];
  const confidenceLabel =
    scores.length > 0
      ? `avg ${(scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(3)} · top ${Math.max(...scores).toFixed(3)}`
      : null;
  if (mode === "cross-search") {
    return {
      yieldLabel: `${count} hits`,
      confidenceLabel: `PR ${prRows.length} · Issue ${issueRows.length}`,
      coverageLabel: null,
    };
  }
  if (mode === "pr-search" || mode === "issue-search") {
    return {
      yieldLabel: `${count} hits${count >= browseLimit ? ` · ${browseLimit} shown` : ""}`,
      confidenceLabel,
      coverageLabel: null,
    };
  }
  return null;
}

export function crossSearchLimits(browseLimit: number): { pr: number; issue: number } {
  const pages = Math.max(1, Math.ceil(browseLimit / DEFAULT_PAGE_SIZE));
  return {
    pr: CROSS_SEARCH_PAGE_SIZE.pr * pages,
    issue: CROSS_SEARCH_PAGE_SIZE.issue * pages,
  };
}

export function currentBrowseCapacity(mode: SearchMode | ListMode, browseLimit: number): number {
  if (mode === "cross-search") {
    const limits = crossSearchLimits(browseLimit);
    return limits.pr + limits.issue;
  }
  return browseLimit;
}

export function compareCrossSearchRows(left: TuiResultRow, right: TuiResultRow): number {
  const leftScore =
    left.kind === "pr" ? left.pr.score : left.kind === "issue" ? left.issue.score : -1;
  const rightScore =
    right.kind === "pr" ? right.pr.score : right.kind === "issue" ? right.issue.score : -1;
  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }
  const leftUpdatedAt =
    left.kind === "pr" ? left.pr.updatedAt : left.kind === "issue" ? left.issue.updatedAt : "";
  const rightUpdatedAt =
    right.kind === "pr" ? right.pr.updatedAt : right.kind === "issue" ? right.issue.updatedAt : "";
  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt.localeCompare(leftUpdatedAt);
  }
  const leftId =
    left.kind === "pr" ? left.pr.prNumber : left.kind === "issue" ? left.issue.issueNumber : 0;
  const rightId =
    right.kind === "pr" ? right.pr.prNumber : right.kind === "issue" ? right.issue.issueNumber : 0;
  return leftId - rightId;
}

export async function resolveListRows(params: {
  mode: ListMode;
  query: string;
  browseLimit: number;
  listPriorityInbox: (options: {
    limit: number;
    scanLimit?: number;
  }) => Promise<PriorityInboxItem[]>;
  listPriorityQueue: (options: {
    limit: number;
    scanLimit?: number;
  }) => Promise<PriorityCandidate[]>;
  listWatchlist: (limit: number) => Promise<PriorityCandidate[]>;
  search: (query: string, limit: number) => Promise<SearchResult[]>;
  searchIssues: (query: string, limit: number) => Promise<IssueSearchResult[]>;
  toPrRow: (
    pr: SearchResult,
    priority?: PriorityCandidate | null,
  ) => Extract<TuiResultRow, { kind: "pr" }>;
  toPriorityClusterRow: (
    cluster: Extract<PriorityInboxItem, { kind: "cluster" }>["cluster"],
  ) => Extract<TuiResultRow, { kind: "priority-cluster" }>;
  toIssueRow: (issue: IssueSearchResult) => Extract<TuiResultRow, { kind: "issue" }>;
  rowUrl: (row: TuiResultRow | undefined) => string | null;
  priorityScanLimit: number;
}): Promise<ListLoadResult> {
  const {
    mode,
    query,
    browseLimit,
    listPriorityInbox,
    listPriorityQueue,
    listWatchlist,
    search,
    searchIssues,
    toPrRow,
    toPriorityClusterRow,
    toIssueRow,
    rowUrl,
    priorityScanLimit,
  } = params;

  if (mode === "inbox") {
    const items = await listPriorityInbox({
      limit: browseLimit,
      scanLimit: priorityScanLimit,
    });
    const rows = items.map((item) =>
      item.kind === "pr"
        ? toPrRow(item.candidate.pr, item.candidate)
        : toPriorityClusterRow(item.cluster),
    );
    return {
      mode,
      rows,
      resultTitle: "Inbox",
      message:
        rows.length > 0
          ? `Loaded ${rows.length} collapsed inbox row(s).`
          : "No prioritized PRs found.",
      activeUrl: rowUrl(rows[0]),
      isLandingView: true,
    };
  }

  if (mode === "watchlist") {
    const candidates = await listWatchlist(browseLimit);
    const rows = candidates.map((candidate) => toPrRow(candidate.pr, candidate));
    return {
      mode,
      rows,
      resultTitle: "Watchlist",
      message: rows.length > 0 ? `Loaded ${rows.length} watched PR(s).` : "Watchlist is empty.",
      activeUrl: rowUrl(rows[0]),
      isLandingView: true,
    };
  }

  if (mode === "cross-search") {
    const searchQuery = query || "state:open";
    const limits = crossSearchLimits(browseLimit);
    const [pullRequests, issues] = await Promise.all([
      search(searchQuery, limits.pr),
      searchIssues(searchQuery, limits.issue),
    ]);
    const rows = [
      ...pullRequests.map((pr) => toPrRow(pr)),
      ...issues.map((issue) => toIssueRow(issue)),
    ].sort(compareCrossSearchRows);
    return {
      mode,
      rows,
      resultTitle: query ? `Explore · ${query}` : "Explore",
      message:
        rows.length > 0
          ? `Loaded ${rows.length} ${query ? "cross-search row" : "cached investigation row"}(s).`
          : query
            ? "No cross-search results."
            : "No cached rows found.",
      activeUrl: rowUrl(rows[0]),
      isLandingView: !query,
    };
  }

  if (mode === "pr-search") {
    const searchQuery = query || "state:open";
    const results = await search(searchQuery, browseLimit);
    const rows = results.map((pr) => toPrRow(pr));
    return {
      mode,
      rows,
      resultTitle: query ? `PRs · ${query}` : "PRs",
      message:
        rows.length > 0
          ? `Loaded ${rows.length} ${query ? "PR result" : "open PR"}(s).`
          : query
            ? "No PR results."
            : "No open PRs found.",
      activeUrl: rowUrl(rows[0]),
      isLandingView: !query,
    };
  }

  const searchQuery = query || "state:open";
  const issues = await searchIssues(searchQuery, browseLimit);
  const rows = issues.map((issue) => toIssueRow(issue));
  return {
    mode,
    rows,
    resultTitle: query ? `Issues · ${query}` : "Issues",
    message:
      rows.length > 0
        ? `Loaded ${rows.length} ${query ? "issue result" : "open issue"}(s).`
        : query
          ? "No issue results."
          : "No open issues found.",
    activeUrl: rowUrl(rows[0]),
    isLandingView: !query,
  };
}
