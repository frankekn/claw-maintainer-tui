import type {
  ClusterCandidate,
  ClusterExcludedCandidate,
  ClusterPullRequestAnalysis,
  IssueSearchResult,
  SearchResult,
  StatusSnapshot,
  SyncSummary,
} from "../types.js";

export type TuiMode =
  | "cross-search"
  | "pr-search"
  | "issue-search"
  | "pr-xref"
  | "issue-xref"
  | "cluster"
  | "status";

export type TuiFocus = "nav" | "results" | "query";

export const TUI_MODE_ORDER: Array<{ id: TuiMode; label: string; queryPrompt: string }> = [
  { id: "cross-search", label: "Cross Search", queryPrompt: "Cross Search" },
  { id: "pr-search", label: "PR Search", queryPrompt: "Search PRs" },
  { id: "issue-search", label: "Issue Search", queryPrompt: "Search Issues" },
  { id: "pr-xref", label: "PR Xref", queryPrompt: "Enter PR Number" },
  { id: "issue-xref", label: "Issue Xref", queryPrompt: "Enter Issue Number" },
  { id: "cluster", label: "Cluster", queryPrompt: "Enter PR Number" },
  { id: "status", label: "Status", queryPrompt: "Status view" },
];

export type TuiActionId =
  | "query"
  | "detail"
  | "xref"
  | "cluster"
  | "sync-prs"
  | "sync-issues"
  | "refresh"
  | "open-url"
  | "back";

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
  | { kind: "pr"; pr: SearchResult; freshness: TuiFreshness }
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
  | { kind: "cluster"; prNumber: number }
  | null;

export type TuiHeaderModel = {
  repo: string;
  dbPath: string;
  activeModeLabel: string;
  ftsOnly: boolean;
  status: StatusSnapshot | null;
  rateLimit: TuiRateLimitSnapshot | null;
  syncMode: TuiSyncMode | null;
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
  search(query: string, limit: number): Promise<SearchResult[]>;
  searchIssues(query: string, limit: number): Promise<IssueSearchResult[]>;
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
  syncPrs(): Promise<SyncSummary>;
  syncIssues(): Promise<SyncSummary>;
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
  showDetail: boolean;
  activeUrl: string | null;
  detailTitle: string;
  resultTitle: string;
  context: TuiContext;
  isLandingView: boolean;
};
