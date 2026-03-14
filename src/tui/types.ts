import type {
  AttentionState,
  ClusterCandidate,
  ClusterExcludedCandidate,
  ClusterPullRequestAnalysis,
  IssueSearchResult,
  PrContextBundle,
  PriorityCandidate,
  SearchResult,
  StatusSnapshot,
  SyncProgressEvent,
  SyncSummary,
} from "../types.js";

export type TuiMode =
  | "inbox"
  | "watchlist"
  | "cross-search"
  | "pr-search"
  | "issue-search"
  | "status";

export type TuiFocus = "nav" | "results" | "detail" | "query";
export type TuiDetailSection =
  | "summary"
  | "linked-issues"
  | "related-prs"
  | "cluster"
  | "maintainer-state";

export const TUI_MODE_ORDER: Array<{ id: TuiMode; label: string; queryPrompt: string }> = [
  { id: "inbox", label: "Inbox", queryPrompt: "Inbox is browse-only" },
  { id: "watchlist", label: "Watchlist", queryPrompt: "Watchlist is browse-only" },
  { id: "cross-search", label: "Explore", queryPrompt: "Search Explore" },
  { id: "pr-search", label: "PRs", queryPrompt: "Search PRs" },
  { id: "issue-search", label: "Issues", queryPrompt: "Search Issues" },
  { id: "status", label: "Status", queryPrompt: "Status view" },
];

export type TuiActionId =
  | "query"
  | "detail"
  | "jump-linked-issues"
  | "cluster"
  | "sync-prs"
  | "sync-issues"
  | "refresh"
  | "load-more"
  | "open-url"
  | "back"
  | "mark-seen"
  | "toggle-watch"
  | "toggle-ignore"
  | "clear-state";

export type TuiAction = {
  id: TuiActionId;
  slot: number;
  label: string;
  shortcut: string;
  enabled: boolean;
};

export type TuiListSummary = {
  yieldLabel: string;
  confidenceLabel: string | null;
  coverageLabel: string | null;
};

export type TuiFreshness = "fresh" | "partial" | "stale";
export type TuiVerificationState = "idle" | "running" | "done" | "rate_limited";
export type TuiSyncMode = "metadata" | "detail" | "cluster_verify";
export type TuiSyncJobState = "idle" | "queued" | "running" | "cooldown" | "error";

export type TuiSyncJobSnapshot = {
  entity: "prs" | "issues";
  state: TuiSyncJobState;
  progress: SyncProgressEvent | null;
  errorMessage: string | null;
  pendingRerun: boolean;
  nextAutoUpdateAt: string | null;
  lastCompletedAt: string | null;
};

export type TuiRateLimitSnapshot = {
  limit: number;
  remaining: number;
  resetAt: string;
};

export type TuiClusterVerificationSummary = {
  verifiedPrCount: number;
  verifiedIssueCount: number;
  missingCount: number;
  state: TuiVerificationState;
};

export type TuiResultRow =
  | { kind: "pr"; pr: SearchResult; freshness: TuiFreshness; priority: PriorityCandidate | null }
  | { kind: "issue"; issue: IssueSearchResult; freshness: TuiFreshness }
  | {
      kind: "cluster-candidate";
      candidate: ClusterCandidate;
      verification: TuiVerificationState;
    }
  | {
      kind: "cluster-excluded";
      candidate: ClusterExcludedCandidate;
      verification: TuiVerificationState;
    }
  | { kind: "status"; label: string; value: string };

export type TuiContext =
  | { kind: "pr"; prNumber: number }
  | { kind: "issue"; issueNumber: number }
  | null;

export type TuiHeaderModel = {
  repo: string;
  dbPath: string;
  activeModeLabel: string;
  ftsOnly: boolean;
  status: StatusSnapshot | null;
  rateLimit: TuiRateLimitSnapshot | null;
  syncMode: TuiSyncMode | null;
  syncJobs: TuiSyncJobSnapshot[];
  detailAutoRefreshInFlight: boolean;
  busyMessage: string | null;
  errorMessage: string | null;
};

export type TuiFooterModel = {
  hintText: string;
  message: string;
  queryPrompt: string;
  queryValue: string;
  actions: TuiAction[];
  autoUpdateHint: string | null;
};

export type TuiRenderModel = {
  header: TuiHeaderModel;
  footer: TuiFooterModel;
  mode: TuiMode;
  focus: TuiFocus;
  rows: TuiResultRow[];
  selectedIndex: number;
  detailText: string;
  detailStatus: string | null;
  detailIdentity: string | null;
  detailAnchorLine: number | null;
  detailAnchorKey: string | null;
  showDetail: boolean;
  activeUrl: string | null;
  query: string;
  resultTitle: string;
  detailTitle: string;
  context: TuiContext;
  queryPlaceholder: string;
  busy: boolean;
  listSummary: TuiListSummary | null;
};

export interface TuiDataService {
  status(): Promise<StatusSnapshot>;
  listPriorityQueue(options: { limit: number; scanLimit?: number }): Promise<PriorityCandidate[]>;
  listWatchlist(limit: number): Promise<PriorityCandidate[]>;
  search(query: string, limit: number): Promise<SearchResult[]>;
  searchIssues(query: string, limit: number): Promise<IssueSearchResult[]>;
  getPrContextBundle(prNumber: number): Promise<PrContextBundle | null>;
  setPrAttentionState(prNumber: number, state: AttentionState | null): Promise<void>;
  show(prNumber: number): Promise<{
    pr: SearchResult | null;
    comments: Array<{
      kind: string;
      author: string;
      createdAt: string;
      url: string;
      excerpt: string;
    }>;
  }>;
  showIssue(issueNumber: number): Promise<IssueSearchResult | null>;
  xrefIssue(
    issueNumber: number,
    limit: number,
  ): Promise<{ issue: IssueSearchResult | null; pullRequests: SearchResult[] }>;
  xrefPr(
    prNumber: number,
    limit: number,
  ): Promise<{ pullRequest: SearchResult | null; issues: IssueSearchResult[] }>;
  clusterPr(prNumber: number, limit: number): Promise<ClusterPullRequestAnalysis | null>;
  verifyClusterPr(
    prNumber: number,
    limit: number,
  ): Promise<{
    analysis: ClusterPullRequestAnalysis | null;
    summary: TuiClusterVerificationSummary;
  }>;
  syncPrs(options?: { onProgress?: (event: SyncProgressEvent) => void }): Promise<SyncSummary>;
  syncIssues(options?: { onProgress?: (event: SyncProgressEvent) => void }): Promise<SyncSummary>;
  refreshPrDetail(prNumber: number): Promise<void>;
  refreshIssueDetail(issueNumber: number): Promise<void>;
  rateLimit(): Promise<TuiRateLimitSnapshot | null>;
}

export type TuiViewSnapshot = {
  mode: TuiMode;
  query: string;
  rows: TuiResultRow[];
  selectedIndex: number;
  detailText: string;
  detailStatus: string | null;
  detailIdentity: string | null;
  detailAnchorLine: number | null;
  detailAnchorKey: string | null;
  showDetail: boolean;
  activeUrl: string | null;
  detailTitle: string;
  resultTitle: string;
  context: TuiContext;
  isLandingView: boolean;
};
