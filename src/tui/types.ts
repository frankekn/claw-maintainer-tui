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

export type SearchMode = "cross-search" | "pr-search" | "issue-search";
export type PriorityMode = "inbox" | "watchlist";
export type ListMode = SearchMode | PriorityMode;
export type MetadataEntity = "prs" | "issues";

export type TuiFocus = "results" | "detail" | "query";
export type TuiDetailSection =
  | "summary"
  | "linked-issues"
  | "related-prs"
  | "cluster"
  | "maintainer-state"
  | "sparse-extras";
export type TuiDetailFoldState = Partial<Record<TuiDetailSection, boolean>>;

export type TuiModeMeta = {
  id: TuiMode;
  label: string;
  browsePrompt: string;
  queryPrompt: string;
  queryFilters: string[];
  queryExamples: string[];
};

export const TUI_MODE_ORDER: TuiModeMeta[] = [
  {
    id: "inbox",
    label: "Inbox",
    browsePrompt: "Browse-only mode · use \u2190/\u2192 or 1-6 to switch desks · ? for help",
    queryPrompt: "Inbox is browse-only",
    queryFilters: [],
    queryExamples: [],
  },
  {
    id: "watchlist",
    label: "Watchlist",
    browsePrompt: "Browse-only mode · use \u2190/\u2192 or 1-6 to switch desks · ? for help",
    queryPrompt: "Watchlist is browse-only",
    queryFilters: [],
    queryExamples: [],
  },
  {
    id: "cross-search",
    label: "Explore",
    browsePrompt: "Search cached PRs and issues",
    queryPrompt: "Explore query",
    queryFilters: ["#123", "label:", "state:", "author:", "branch:"],
    queryExamples: ['state:open label:"size: XS"', "author:frank marker spoofing"],
  },
  {
    id: "pr-search",
    label: "PRs",
    browsePrompt: "Search cached PRs",
    queryPrompt: "PR query",
    queryFilters: ["#123", "label:", "state:", "author:", "branch:"],
    queryExamples: ['state:open label:"size: XS"', "branch:feature/fix-cache"],
  },
  {
    id: "issue-search",
    label: "Issues",
    browsePrompt: "Search cached issues",
    queryPrompt: "Issue query",
    queryFilters: ["#123", "label:", "state:", "author:"],
    queryExamples: ["state:open label:bug", "author:frank updated"],
  },
  {
    id: "status",
    label: "Status",
    browsePrompt: "Status view · use s/S to sync · ? for help",
    queryPrompt: "Status view",
    queryFilters: [],
    queryExamples: [],
  },
];

export const DETAIL_WIDTH_PRESETS = [
  { results: "64%", detail: "36%", label: "36%" },
  { results: "58%", detail: "42%", label: "42%" },
  { results: "52%", detail: "48%", label: "48%" },
] as const;

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
  | "mark-page-seen"
  | "toggle-watch"
  | "toggle-ignore"
  | "clear-state"
  | "undo";

export type TuiAttentionMutation = {
  prNumbers: number[];
  previousStates: Array<AttentionState | null>;
  nextState: AttentionState | null;
  message: string;
};

export type TuiAction = {
  id: TuiActionId;
  label: string;
  shortcut: string;
  enabled: boolean;
};

export type TuiBannerTone = "info" | "success" | "warn" | "error";

export type TuiBanner = {
  tone: TuiBannerTone;
  message: string;
  actions: string[];
  dismissible: boolean;
};

export type TuiQueryState = {
  value: string;
  history: string[];
  historyIndex: number | null;
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

export type TuiClusterWorkspaceDetail = {
  seedLabel: string;
  clusterBasis: string;
  clusterIssues: number[];
  verificationSummary: string | null;
  mergeSummary: string | null;
};

export type TuiClusterWorkspaceState = {
  seedPrNumber: number;
  analysis: ClusterPullRequestAnalysis;
  verification: TuiClusterVerificationSummary;
  showExcluded: boolean;
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
      detail: TuiClusterWorkspaceDetail;
    }
  | {
      kind: "cluster-excluded";
      candidate: ClusterExcludedCandidate;
      verification: TuiVerificationState;
      detail: TuiClusterWorkspaceDetail;
    }
  | { kind: "status"; label: string; value: string };

export type TuiContext =
  | { kind: "pr"; prNumber: number }
  | { kind: "issue"; issueNumber: number }
  | null;

export type TuiDetailPayload =
  | { kind: "landing"; mode: TuiMode; status: StatusSnapshot | null }
  | { kind: "pr"; bundle: PrContextBundle }
  | {
      kind: "cluster";
      analysis: TuiClusterWorkspaceDetail;
      candidate: ClusterCandidate | ClusterExcludedCandidate;
    }
  | { kind: "issue"; issue: IssueSearchResult }
  | { kind: "status"; status: StatusSnapshot | null };

export type TuiDetailState = {
  visible: boolean;
  payload: TuiDetailPayload;
  status: string | null;
  identity: string | null;
  focusSection: TuiDetailSection | null;
  anchorKey: string | null;
  foldedSections: TuiDetailFoldState;
};

export type TuiSessionState = {
  mode: TuiMode;
  focus: TuiFocus;
  rows: TuiResultRow[];
  selectedIndex: number;
  activeUrl: string | null;
  query: string;
  queryState: Record<SearchMode, TuiQueryState>;
  context: TuiContext;
  resultTitle: string;
  message: string;
  errorMessage: string | null;
  browseLimit: number;
  isLandingView: boolean;
  banner: TuiBanner | null;
  bannerHidden: boolean;
  helpVisible: boolean;
  detailLayoutMode: Exclude<TuiLayoutMode, "single-pane">;
  detailWidthIndex: number;
  clusterWorkspace: TuiClusterWorkspaceState | null;
  lastAttentionMutation: TuiAttentionMutation | null;
  history: TuiViewSnapshot[];
};

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
  | { type: "activate_mode_index"; index: number }
  | { type: "move_selection"; delta: number }
  | { type: "toggle_detail" }
  | { type: "toggle_detail_layout" }
  | { type: "resize_detail"; delta: -1 | 1 }
  | { type: "toggle_detail_section_fold" }
  | { type: "expand_cluster" }
  | { type: "jump_detail_section"; section: Extract<TuiDetailSection, "linked-issues" | "cluster"> }
  | { type: "toggle_help" }
  | { type: "dismiss_banner" }
  | { type: "start_query" }
  | { type: "stop_query" }
  | { type: "append_query"; value: string }
  | { type: "backspace_query" }
  | { type: "query_history_prev" }
  | { type: "query_history_next" }
  | { type: "submit_query" }
  | { type: "go_back" }
  | { type: "mark_seen" }
  | { type: "mark_visible_seen" }
  | { type: "toggle_watch" }
  | { type: "toggle_ignore" }
  | { type: "clear_attention_state" }
  | { type: "undo_attention_state" }
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
  banner: TuiBanner | null;
  queryPrompt: string;
  queryValue: string;
  queryPlaceholder: string;
  queryHelpText: string;
  actions: TuiAction[];
  keys: TuiAction[];
  autoUpdateHint: string | null;
};

export type TuiLayoutMode = "single-pane" | "split-pane" | "detail-fullscreen";

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

export type TuiHelpOverlayModel = {
  visible: boolean;
  title: string;
  lines: string[];
};

export type TuiRenderModel = {
  header: TuiHeaderModel;
  footer: TuiFooterModel;
  helpOverlay: TuiHelpOverlayModel;
  mode: TuiMode;
  focus: TuiFocus;
  layoutMode: TuiLayoutMode;
  resultsWidth: string;
  detailWidth: string;
  resultsPane: TuiResultsPaneModel;
  detailPane: TuiDetailPaneModel;
  activeUrl: string | null;
  query: string;
  context: TuiContext;
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
