import type {
  AttentionState,
  ClusterCandidate,
  ClusterExcludedCandidate,
  ClusterPullRequestAnalysis,
  IssueSearchResult,
  PullRequestShowResult,
  PrContextBundle,
  PriorityCandidate,
  PriorityClusterSummary,
  PriorityInboxItem,
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
  | "expand-cluster"
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
  | {
      kind: "priority-cluster";
      cluster: PriorityClusterSummary;
      freshness: TuiFreshness;
    }
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

export type TuiDetailPayload =
  | { kind: "landing"; mode: TuiMode; status: StatusSnapshot | null }
  | { kind: "pr"; bundle: PrContextBundle }
  | { kind: "issue"; issue: IssueSearchResult }
  | { kind: "status"; status: StatusSnapshot | null };

export type TuiDetailState = {
  visible: boolean;
  payload: TuiDetailPayload;
  status: string | null;
  identity: string | null;
  focusSection: TuiDetailSection | null;
  anchorKey: string | null;
};

export type TuiSessionState = {
  mode: TuiMode;
  focus: TuiFocus;
  rows: TuiResultRow[];
  selectedIndex: number;
  activeUrl: string | null;
  query: string;
  context: TuiContext;
  resultTitle: string;
  message: string;
  errorMessage: string | null;
  browseLimit: number;
  isLandingView: boolean;
  history: TuiViewSnapshot[];
};

export type SearchMode = "cross-search" | "pr-search" | "issue-search";
export type PriorityMode = "inbox" | "watchlist";
export type ListMode = SearchMode | PriorityMode;
export type MetadataEntity = "prs" | "issues";

export type ListLoadResult = {
  mode: ListMode;
  rows: TuiResultRow[];
  resultTitle: string;
  message: string;
  activeUrl: string | null;
  isLandingView: boolean;
};

export type LoadedDetailResult = {
  payload: TuiDetailPayload;
  identity: string | null;
  status: string | null;
  context: { kind: "pr"; prNumber: number } | { kind: "issue"; issueNumber: number } | null;
  activeUrl: string | null;
  focusSection: TuiDetailSection | null;
};

export type TuiCommand =
  | { type: "focus_next" }
  | { type: "focus_results" }
  | { type: "activate_mode"; delta: number }
  | { type: "move_selection"; delta: number }
  | { type: "toggle_detail" }
  | { type: "expand_cluster" }
  | { type: "jump_detail_section"; section: Extract<TuiDetailSection, "linked-issues" | "cluster"> }
  | { type: "start_query" }
  | { type: "stop_query" }
  | { type: "append_query"; value: string }
  | { type: "backspace_query" }
  | { type: "submit_query" }
  | { type: "trigger_action"; slot: number }
  | { type: "go_back" }
  | { type: "mark_seen" }
  | { type: "toggle_watch" }
  | { type: "toggle_ignore" }
  | { type: "clear_attention_state" }
  | { type: "sync_prs" }
  | { type: "sync_issues" }
  | { type: "refresh_selected" }
  | { type: "load_more" };

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

export type TuiLayoutMode = "single-pane" | "split-pane";

export type TuiResultsPaneModel = {
  title: string;
  summary: TuiListSummary | null;
  rows: TuiResultRow[];
  selectedIndex: number;
  lines: string[];
};

export type TuiDetailPaneModel = {
  visible: boolean;
  title: string;
  status: string | null;
  lines: string[];
  identity: string | null;
  anchorLine: number | null;
  anchorKey: string | null;
};

export type TuiRenderModel = {
  header: TuiHeaderModel;
  footer: TuiFooterModel;
  mode: TuiMode;
  focus: TuiFocus;
  layoutMode: TuiLayoutMode;
  resultsPane: TuiResultsPaneModel;
  detailPane: TuiDetailPaneModel;
  activeUrl: string | null;
  query: string;
  context: TuiContext;
  queryPlaceholder: string;
  busy: boolean;
};

export interface TuiDataService {
  status(): Promise<StatusSnapshot>;
  listPriorityInbox(options: { limit: number; scanLimit?: number }): Promise<PriorityInboxItem[]>;
  listPriorityQueue(options: { limit: number; scanLimit?: number }): Promise<PriorityCandidate[]>;
  listWatchlist(limit: number): Promise<PriorityCandidate[]>;
  search(query: string, limit: number): Promise<SearchResult[]>;
  searchIssues(query: string, limit: number): Promise<IssueSearchResult[]>;
  getPrContextBundle(prNumber: number): Promise<PrContextBundle | null>;
  setPrAttentionState(prNumber: number, state: AttentionState | null): Promise<void>;
  show(prNumber: number): Promise<PullRequestShowResult>;
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
  session: Omit<TuiSessionState, "history">;
  detail: TuiDetailState;
};
