import {
  buildStatusRows,
  defaultSecondaryHintText,
  formatCrossSearchLandingDetail,
  formatInboxLandingDetail,
  formatIssueDetail,
  formatPriorityPrDetail,
  formatSearchLandingDetail,
  formatStatusDetail,
  formatWatchlistLandingDetail,
} from "./format.js";
import { TUI_MODE_ORDER } from "./types.js";
import type {
  AttentionState,
  IssueSearchResult,
  PriorityAttentionState,
  SearchResult,
  StatusSnapshot,
  SyncProgressEvent,
} from "../types.js";
import type {
  TuiAction,
  TuiActionId,
  TuiContext,
  TuiDataService,
  TuiDetailSection,
  TuiFocus,
  TuiFreshness,
  TuiListSummary,
  TuiMode,
  TuiRenderModel,
  TuiResultRow,
  TuiSyncJobSnapshot,
  TuiSyncMode,
  TuiViewSnapshot,
} from "./types.js";

type ControllerOptions = {
  repo: string;
  dbPath: string;
  ftsOnly: boolean;
  resultLimit?: number;
};

type SearchMode = "cross-search" | "pr-search" | "issue-search";
type PriorityMode = "inbox" | "watchlist";
type ListMode = SearchMode | PriorityMode;
type MetadataEntity = "prs" | "issues";
type ListLoadResult = {
  mode: ListMode;
  rows: TuiResultRow[];
  resultTitle: string;
  detailTitle: string;
  detailText: string;
  message: string;
  activeUrl: string | null;
  isLandingView: boolean;
};

const DEFAULT_PAGE_SIZE = 20;
const CROSS_SEARCH_PAGE_SIZE = {
  pr: 10,
  issue: 10,
} as const;
const PRIORITY_SCAN_LIMIT = 300;
const ENTRY_STALE_MS = 10 * 60 * 1000;
const IDLE_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_TIMEOUT_MS = 30 * 1000;
const REPLAY_DEBOUNCE_MS = 150;

export class TuiController {
  private readonly listeners = new Set<() => void>();
  private readonly resultLimit: number;
  private browseLimit: number;
  private statusSnapshot: StatusSnapshot | null = null;
  private mode: TuiMode = "inbox";
  private focus: TuiFocus = "results";
  private rows: TuiResultRow[] = [];
  private selectedIndex = 0;
  private detailText = "Loading Inbox...";
  private detailTitle = "Start Here";
  private detailStatus: string | null = null;
  private detailIdentity: string | null = null;
  private detailAnchorLine: number | null = null;
  private detailAnchorKey: string | null = null;
  private detailAnchorNonce = 0;
  private showDetail = false;
  private resultTitle = "Inbox";
  private activeUrl: string | null = null;
  private query = "";
  private context: TuiContext = null;
  private busyMessage: string | null = null;
  private syncMode: TuiSyncMode | null = null;
  private errorMessage: string | null = null;
  private message = "Loading Inbox...";
  private readonly history: TuiViewSnapshot[] = [];
  private detailRequestId = 0;
  private listRequestId = 0;
  private isLandingView = false;
  private detailAutoRefreshInFlight = false;
  private readonly detailFreshness = new Map<string, TuiFreshness>();
  private rateLimitSnapshot: Awaited<ReturnType<TuiDataService["rateLimit"]>> = null;
  private readonly syncJobs: Record<MetadataEntity, TuiSyncJobSnapshot> = {
    prs: {
      entity: "prs",
      state: "idle",
      progress: null,
      errorMessage: null,
      pendingRerun: false,
      nextAutoUpdateAt: null,
      lastCompletedAt: null,
    },
    issues: {
      entity: "issues",
      state: "idle",
      progress: null,
      errorMessage: null,
      pendingRerun: false,
      nextAutoUpdateAt: null,
      lastCompletedAt: null,
    },
  };
  private activeMetadataJob: MetadataEntity | null = null;
  private readonly manualPriority = new Set<MetadataEntity>();
  private idleRefreshTimer: NodeJS.Timeout | null = null;
  private replayTimer: NodeJS.Timeout | null = null;
  private lastInteractionAt = Date.now();

  constructor(
    private readonly service: TuiDataService,
    private readonly options: ControllerOptions,
  ) {
    this.resultLimit = options.resultLimit ?? DEFAULT_PAGE_SIZE;
    this.browseLimit = this.resultLimit;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getRenderModel(): TuiRenderModel {
    const modeInfo = TUI_MODE_ORDER.find((mode) => mode.id === this.mode)!;
    return {
      header: {
        repo: this.options.repo,
        dbPath: this.options.dbPath,
        activeModeLabel: modeInfo.label,
        ftsOnly: this.options.ftsOnly,
        status: this.statusSnapshot,
        rateLimit: this.rateLimitSnapshot,
        syncMode: this.syncMode,
        syncJobs: Object.values(this.syncJobs),
        detailAutoRefreshInFlight: this.detailAutoRefreshInFlight,
        busyMessage: this.busyMessage,
        errorMessage: this.errorMessage,
      },
      footer: {
        hintText: defaultSecondaryHintText(this.mode, this.canLoadMore()),
        message: this.errorMessage ?? this.message,
        queryPrompt: modeInfo.queryPrompt,
        queryValue: this.query,
        actions: this.buildActions(),
        autoUpdateHint: "auto-update every 5m when idle",
      },
      mode: this.mode,
      focus: this.focus,
      rows: this.rows,
      selectedIndex: this.selectedIndex,
      detailText: this.detailText,
      detailStatus: this.detailStatus,
      detailIdentity: this.detailIdentity,
      detailAnchorLine: this.detailAnchorLine,
      detailAnchorKey: this.detailAnchorKey,
      showDetail: this.showDetail,
      activeUrl: this.getActiveUrl(),
      query: this.query,
      resultTitle: this.resultTitle,
      detailTitle: this.detailTitle,
      context: this.context,
      queryPlaceholder: modeInfo.queryPrompt,
      busy: this.busyMessage !== null,
      listSummary: this.buildListSummary(),
    };
  }

  async initialize(): Promise<void> {
    this.message = "Loading Inbox...";
    this.emit();
    await this.refreshStatus();
    await this.loadLandingRows("inbox");
    this.scheduleAutoSync("inbox");
    this.ensureIdleRefreshTimer();
    this.emit();
  }

  noteInteraction(): void {
    this.lastInteractionAt = Date.now();
  }

  isQueryFocus(): boolean {
    return this.focus === "query";
  }

  isNavFocus(): boolean {
    return this.focus === "nav";
  }

  isDetailFocus(): boolean {
    return this.focus === "detail";
  }

  focusNext(): void {
    const order = this.availableFocuses();
    const currentIndex = order.indexOf(this.focus);
    this.focus = order[(currentIndex + 1) % order.length] ?? "results";
    this.emit();
  }

  focusResults(): void {
    this.focus = "results";
    this.emit();
  }

  activateMode(mode: TuiMode): void {
    if (mode === this.mode) {
      this.message = `Switched to ${this.modeLabel(mode)}.`;
      this.emit();
      return;
    }
    this.pushHistory();
    this.mode = mode;
    this.focus = "results";
    this.rows = [];
    this.selectedIndex = 0;
    this.showDetail = false;
    this.detailStatus = null;
    this.detailIdentity = null;
    this.detailAnchorLine = null;
    this.detailAnchorKey = null;
    this.detailAutoRefreshInFlight = false;
    this.context = null;
    this.activeUrl = null;
    this.query = "";
    this.browseLimit = this.resultLimit;
    this.errorMessage = null;
    this.isLandingView = false;
    this.resultTitle = this.modeLabel(mode);
    this.detailTitle = "Start Here";
    this.message = this.isListMode(mode)
      ? `Loading ${this.modeLabel(mode)}...`
      : `Switched to ${this.modeLabel(mode)}.`;
    this.detailText =
      mode === "status"
        ? this.statusSnapshot
          ? formatStatusDetail(this.statusSnapshot)
          : "Loading repository status..."
        : `Switched to ${this.modeLabel(mode)}.`;
    this.emit();

    if (this.isListMode(mode)) {
      void this.loadLandingRows(mode);
      this.scheduleAutoSync(mode);
      return;
    }
    if (mode === "status" && this.statusSnapshot) {
      this.rows = buildStatusRows(this.statusSnapshot);
      this.resultTitle = "Status";
      this.detailTitle = "Repository Status";
      this.detailText = formatStatusDetail(this.statusSnapshot);
      this.emit();
    }
  }

  startQueryEntry(): void {
    if (!this.isQueryMode(this.mode)) {
      return;
    }
    this.focus = "query";
    this.emit();
  }

  canStartSlashQuery(): boolean {
    return this.isQueryMode(this.mode);
  }

  stopQueryEntry(): void {
    if (this.focus !== "query") {
      return;
    }
    this.focus = "results";
    this.emit();
  }

  appendQueryCharacter(value: string): void {
    if (this.focus !== "query") {
      return;
    }
    this.query += value;
    this.emit();
  }

  backspaceQuery(): void {
    if (this.focus !== "query" || this.query.length === 0) {
      return;
    }
    this.query = this.query.slice(0, -1);
    this.emit();
  }

  async submitCurrentQuery(): Promise<void> {
    if (!this.isQueryMode(this.mode)) {
      return;
    }
    this.browseLimit = this.resultLimit;
    await this.submitQuery(this.query);
    this.focus = "results";
    this.emit();
  }

  moveSelection(delta: number): void {
    if (this.focus === "nav") {
      this.moveMode(delta);
      return;
    }
    if (this.focus !== "results" || this.rows.length === 0) {
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(this.rows.length - 1, this.selectedIndex + delta));
    this.activeUrl = this.rowUrl(this.rows[this.selectedIndex]);
    this.emit();
    if (this.showDetail) {
      void this.refreshDetailForSelection(true);
    }
  }

  moveMode(delta: number): void {
    const currentIndex = TUI_MODE_ORDER.findIndex((mode) => mode.id === this.mode);
    const nextIndex = Math.max(0, Math.min(TUI_MODE_ORDER.length - 1, currentIndex + delta));
    this.activateMode(TUI_MODE_ORDER[nextIndex]!.id);
  }

  async submitQuery(value: string): Promise<void> {
    if (!this.isQueryMode(this.mode)) {
      return;
    }
    const mode = this.mode;
    this.query = value.trim();
    this.errorMessage = null;
    this.isLandingView = false;
    this.showDetail = false;
    this.detailStatus = null;
    this.detailIdentity = null;
    this.detailAnchorLine = null;
    this.detailAnchorKey = null;
    this.activeUrl = null;
    const requestId = ++this.listRequestId;
    if (!this.query) {
      await this.loadLandingRows(mode);
      return;
    }
    await this.runBusy(`Searching ${this.modeLabel(mode)}`, async () => {
      const result = await this.resolveListRows(mode, this.query);
      if (requestId !== this.listRequestId || this.mode !== mode) {
        return;
      }
      this.applyListResult(result);
      this.context = null;
      this.emit();
    });
  }

  async openSelected(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row) {
      return;
    }
    if (this.showDetail) {
      this.showDetail = false;
      this.detailStatus = null;
      this.detailIdentity = null;
      this.detailAnchorLine = null;
      this.detailAnchorKey = null;
      this.loadLandingDetailForCurrentMode();
      this.focus = "results";
      this.message = "Closed detail drawer.";
      this.emit();
      return;
    }
    this.showDetail = true;
    this.isLandingView = false;
    await this.refreshDetailForSelection(true);
  }

  async triggerAction(slot: number): Promise<void> {
    const action = this.buildActions().find((item) => item.slot === slot && item.enabled);
    if (!action) {
      return;
    }
    switch (action.id) {
      case "query":
        this.startQueryEntry();
        return;
      case "detail":
        await this.openSelected();
        return;
      case "jump-linked-issues":
        await this.crossReferenceSelected();
        return;
      case "cluster":
        await this.clusterSelected();
        return;
      case "mark-seen":
        await this.markSeenSelected();
        return;
      case "toggle-watch":
        await this.toggleWatchSelected();
        return;
      case "toggle-ignore":
        await this.toggleIgnoreSelected();
        return;
      case "clear-state":
        await this.clearSelectedAttentionState();
        return;
      case "sync-prs":
        await this.syncPrs();
        return;
      case "sync-issues":
        await this.syncIssues();
        return;
      case "refresh":
        await this.refreshSelected();
        return;
      case "load-more":
        await this.loadMore();
        return;
      case "back":
        this.goBack();
        return;
      case "open-url":
      default:
        return;
    }
  }

  async crossReferenceSelected(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row || row.kind !== "pr") {
      return;
    }
    await this.openPrDetailSection("linked-issues");
  }

  async clusterSelected(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row || row.kind !== "pr") {
      return;
    }
    await this.openPrDetailSection("cluster");
  }

  async markSeenSelected(): Promise<void> {
    await this.updateAttentionState("seen", "Marked PR as seen.");
  }

  async toggleWatchSelected(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row || row.kind !== "pr") {
      return;
    }
    const current = await this.currentAttentionState(row.pr.prNumber, row.priority?.attentionState);
    await this.updateAttentionState(
      current === "watch" ? null : "watch",
      current === "watch" ? "Cleared watch state." : "Added PR to watchlist.",
    );
  }

  async toggleIgnoreSelected(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row || row.kind !== "pr") {
      return;
    }
    const current = await this.currentAttentionState(row.pr.prNumber, row.priority?.attentionState);
    await this.updateAttentionState(
      current === "ignore" ? null : "ignore",
      current === "ignore" ? "Cleared ignore state." : "Ignored PR in Inbox.",
    );
  }

  async clearSelectedAttentionState(): Promise<void> {
    await this.updateAttentionState(null, "Cleared local triage state.");
  }

  async syncPrs(): Promise<void> {
    this.queueMetadataSync("prs", "manual");
    this.emit();
  }

  async syncIssues(): Promise<void> {
    this.queueMetadataSync("issues", "manual");
    this.emit();
  }

  goBack(): void {
    const snapshot = this.history.pop();
    if (!snapshot) {
      this.message = "No previous view.";
      this.emit();
      return;
    }
    this.mode = snapshot.mode;
    this.query = snapshot.query;
    this.rows = snapshot.rows;
    this.selectedIndex = snapshot.selectedIndex;
    this.detailText = snapshot.detailText;
    this.detailStatus = snapshot.detailStatus;
    this.detailIdentity = snapshot.detailIdentity;
    this.detailAnchorLine = snapshot.detailAnchorLine;
    this.detailAnchorKey = snapshot.detailAnchorKey;
    this.showDetail = snapshot.showDetail;
    this.activeUrl = snapshot.activeUrl;
    this.detailTitle = snapshot.detailTitle;
    this.resultTitle = snapshot.resultTitle;
    this.context = snapshot.context;
    this.isLandingView = snapshot.isLandingView;
    this.errorMessage = null;
    this.focus = "results";
    this.message = "Returned to previous view.";
    this.emit();
  }

  getActiveUrl(): string | null {
    return this.activeUrl ?? this.rowUrl(this.rows[this.selectedIndex]);
  }

  async refreshSelected(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row) {
      return;
    }
    if (row.kind === "pr") {
      await this.refreshDetailForPr(row.pr.prNumber, true);
      return;
    }
    if (row.kind === "issue") {
      await this.refreshDetailForIssue(row.issue.issueNumber, true);
    }
  }

  private async updateAttentionState(state: AttentionState | null, message: string): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row || row.kind !== "pr") {
      return;
    }
    await this.service.setPrAttentionState(row.pr.prNumber, state);
    this.message = message;
    await this.refreshActiveListPreservingUi();
  }

  private async currentAttentionState(
    prNumber: number,
    fromRow: PriorityAttentionState | null | undefined,
  ): Promise<PriorityAttentionState> {
    if (fromRow) {
      return fromRow;
    }
    const bundle = await this.service.getPrContextBundle(prNumber);
    return bundle?.candidate.attentionState ?? "new";
  }

  private buildActions(): TuiAction[] {
    const row = this.rows[this.selectedIndex];
    const hasRow = Boolean(row);
    const hasHistory = this.history.length > 0;
    const canJumpContext = row?.kind === "pr";
    const canTriage = row?.kind === "pr";
    const canRefresh = row?.kind === "pr" || row?.kind === "issue";
    const hasLocalState = row?.kind === "pr" && (row.priority?.attentionState ?? "new") !== "new";

    switch (this.mode) {
      case "inbox":
      case "watchlist":
        return [
          this.action(1, "detail", this.showDetail ? "Close" : "Detail", "Enter", hasRow),
          this.action(2, "jump-linked-issues", "Linked", "x", canJumpContext),
          this.action(3, "cluster", "Cluster", "c", canJumpContext),
          this.action(4, "mark-seen", "Seen", "v", canTriage),
          this.action(5, "toggle-watch", "Watch", "w", canTriage),
          this.action(6, "toggle-ignore", "Ignore", "i", canTriage),
          this.action(7, "clear-state", "Clear", "u", hasLocalState),
          this.action(8, "load-more", "More", "m", this.canLoadMore()),
        ];
      case "cross-search":
        return [
          this.action(1, "query", "Search", "/"),
          this.action(2, "detail", this.showDetail ? "Close" : "Detail", "Enter", hasRow),
          this.action(3, "jump-linked-issues", "Linked", "x", canJumpContext),
          this.action(4, "cluster", "Cluster", "c", canJumpContext),
          this.action(5, "sync-prs", "Sync PRs", "s"),
          this.action(6, "sync-issues", "Sync Issues", "S"),
          this.action(7, "refresh", "Refresh", "r", canRefresh),
          this.action(8, "load-more", "More", "m", this.canLoadMore()),
        ];
      case "pr-search":
        return [
          this.action(1, "query", "Search", "/"),
          this.action(2, "detail", this.showDetail ? "Close" : "Detail", "Enter", hasRow),
          this.action(3, "jump-linked-issues", "Linked", "x", canJumpContext),
          this.action(4, "cluster", "Cluster", "c", canJumpContext),
          this.action(5, "mark-seen", "Seen", "v", canTriage),
          this.action(6, "toggle-watch", "Watch", "w", canTriage),
          this.action(7, "refresh", "Refresh", "r", canRefresh),
          this.action(8, "load-more", "More", "m", this.canLoadMore()),
        ];
      case "issue-search":
        return [
          this.action(1, "query", "Search", "/"),
          this.action(2, "detail", this.showDetail ? "Close" : "Detail", "Enter", hasRow),
          this.action(3, "sync-issues", "Sync Issues", "S"),
          this.action(4, "refresh", "Refresh", "r", canRefresh),
          this.action(5, "back", "Back", "b", hasHistory),
          this.action(6, "load-more", "More", "m", this.canLoadMore()),
        ];
      case "status":
        return [
          this.action(1, "sync-prs", "Sync PRs", "s"),
          this.action(2, "sync-issues", "Sync Issues", "S"),
          this.action(3, "back", "Back", "b", hasHistory),
        ];
      default:
        return [];
    }
  }

  private buildListSummary(): TuiListSummary | null {
    const count = this.rows.length;
    if (this.mode === "status") {
      return { yieldLabel: `${count} metrics`, confidenceLabel: null, coverageLabel: null };
    }
    if (this.mode === "inbox" || this.mode === "watchlist") {
      const prRows = this.rows.filter(
        (row): row is Extract<TuiResultRow, { kind: "pr" }> => row.kind === "pr",
      );
      const linkedCount = prRows.filter((row) => (row.priority?.linkedIssueCount ?? 0) > 0).length;
      const relatedCount = prRows.filter(
        (row) => (row.priority?.relatedPullRequestCount ?? 0) > 0,
      ).length;
      return {
        yieldLabel: `${count} PR${count === 1 ? "" : "s"}${count >= this.browseLimit ? ` · ${this.browseLimit} shown` : ""}`,
        confidenceLabel: `issue-linked ${linkedCount} · related ${relatedCount}`,
        coverageLabel: this.mode === "watchlist" ? "local watch state" : "priority queue",
      };
    }

    const prRows = this.rows.filter(
      (row): row is Extract<TuiResultRow, { kind: "pr" }> => row.kind === "pr",
    );
    const issueRows = this.rows.filter(
      (row): row is Extract<TuiResultRow, { kind: "issue" }> => row.kind === "issue",
    );
    const scores = [
      ...prRows.map((row) => row.pr.score),
      ...issueRows.map((row) => row.issue.score),
    ];
    const confidenceLabel =
      scores.length > 0
        ? `avg ${(scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(3)} · top ${Math.max(...scores).toFixed(3)}`
        : null;
    if (this.mode === "cross-search") {
      return {
        yieldLabel: `${count} hits`,
        confidenceLabel: `PR ${prRows.length} · Issue ${issueRows.length}`,
        coverageLabel: null,
      };
    }
    if (this.mode === "pr-search" || this.mode === "issue-search") {
      return {
        yieldLabel: `${count} hits${count >= this.browseLimit ? ` · ${this.browseLimit} shown` : ""}`,
        confidenceLabel,
        coverageLabel: null,
      };
    }
    return null;
  }

  private action(
    slot: number,
    id: TuiActionId,
    label: string,
    shortcut: string,
    enabled = true,
  ): TuiAction {
    return { slot, id, label, shortcut, enabled };
  }

  private pushHistory(): void {
    if (this.rows.length === 0 && !this.query && this.mode === "inbox") {
      return;
    }
    this.history.push({
      mode: this.mode,
      query: this.query,
      rows: this.rows,
      selectedIndex: this.selectedIndex,
      detailText: this.detailText,
      detailStatus: this.detailStatus,
      detailIdentity: this.detailIdentity,
      detailAnchorLine: this.detailAnchorLine,
      detailAnchorKey: this.detailAnchorKey,
      showDetail: this.showDetail,
      activeUrl: this.activeUrl,
      detailTitle: this.detailTitle,
      resultTitle: this.resultTitle,
      context: this.context,
      isLandingView: this.isLandingView,
    });
  }

  private async refreshStatus(): Promise<void> {
    this.statusSnapshot = await this.service.status();
    try {
      this.rateLimitSnapshot = await this.service.rateLimit();
    } catch {
      this.rateLimitSnapshot = this.rateLimitSnapshot ?? null;
    }
    if (this.mode === "status" && this.statusSnapshot) {
      this.rows = buildStatusRows(this.statusSnapshot);
      this.detailTitle = "Repository Status";
      this.detailText = formatStatusDetail(this.statusSnapshot);
    }
  }

  private async loadLandingRows(mode: ListMode): Promise<void> {
    const requestId = ++this.listRequestId;
    this.isLandingView = true;
    this.showDetail = false;
    this.detailStatus = null;
    this.detailIdentity = null;
    this.detailAnchorLine = null;
    this.detailAnchorKey = null;
    this.message = `Loading ${this.modeLabel(mode)}...`;
    this.emit();
    try {
      const result = await this.resolveListRows(mode, "");
      if (requestId !== this.listRequestId || this.mode !== mode) {
        return;
      }
      this.applyListResult(result);
      this.emit();
    } catch (error) {
      if (requestId !== this.listRequestId) {
        return;
      }
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.message = "Failed to load rows.";
      this.emit();
    }
  }

  private applyListResult(result: ListLoadResult): void {
    this.rows = result.rows;
    this.selectedIndex = 0;
    this.resultTitle = result.resultTitle;
    this.detailTitle = result.detailTitle;
    this.detailText = result.detailText;
    this.message = result.message;
    this.activeUrl = result.activeUrl;
    this.isLandingView = result.isLandingView;
  }

  private async resolveListRows(mode: ListMode, query: string): Promise<ListLoadResult> {
    if (mode === "inbox") {
      const candidates = await this.service.listPriorityQueue({
        limit: this.browseLimit,
        scanLimit: PRIORITY_SCAN_LIMIT,
      });
      const rows = candidates.map((candidate) => this.toPrRow(candidate.pr, candidate));
      return {
        mode,
        rows,
        resultTitle: "Inbox",
        detailTitle: "Start Here",
        detailText: formatInboxLandingDetail(this.statusSnapshot),
        message:
          rows.length > 0
            ? `Loaded ${rows.length} prioritized PR(s).`
            : "No prioritized PRs found.",
        activeUrl: this.rowUrl(rows[0]),
        isLandingView: true,
      };
    }

    if (mode === "watchlist") {
      const candidates = await this.service.listWatchlist(this.browseLimit);
      const rows = candidates.map((candidate) => this.toPrRow(candidate.pr, candidate));
      return {
        mode,
        rows,
        resultTitle: "Watchlist",
        detailTitle: "Start Here",
        detailText: formatWatchlistLandingDetail(this.statusSnapshot),
        message: rows.length > 0 ? `Loaded ${rows.length} watched PR(s).` : "Watchlist is empty.",
        activeUrl: this.rowUrl(rows[0]),
        isLandingView: true,
      };
    }

    if (mode === "cross-search") {
      const searchQuery = query || "state:open";
      const limits = this.crossSearchLimits();
      const [pullRequests, issues] = await Promise.all([
        this.service.search(searchQuery, limits.pr),
        this.service.searchIssues(searchQuery, limits.issue),
      ]);
      const rows = [
        ...pullRequests.map((pr) => this.toPrRow(pr)),
        ...issues.map((issue) => this.toIssueRow(issue)),
      ];
      return {
        mode,
        rows,
        resultTitle: query ? `Explore · ${query}` : "Explore",
        detailTitle: "Start Here",
        detailText: query
          ? "Explore mixes cached PRs and issues. Press Enter to inspect the selected row."
          : formatCrossSearchLandingDetail(this.statusSnapshot),
        message:
          rows.length > 0
            ? `Loaded ${rows.length} ${query ? "cross-search row" : "cached investigation row"}(s).`
            : query
              ? "No cross-search results."
              : "No cached rows found.",
        activeUrl: this.rowUrl(rows[0]),
        isLandingView: !query,
      };
    }

    if (mode === "pr-search") {
      const searchQuery = query || "state:open";
      const results = await this.service.search(searchQuery, this.browseLimit);
      const rows = results.map((pr) => this.toPrRow(pr));
      return {
        mode,
        rows,
        resultTitle: query ? `PRs · ${query}` : "PRs",
        detailTitle: "Start Here",
        detailText: query
          ? "Press Enter to open the selected PR investigation workspace."
          : formatSearchLandingDetail("pr-search", this.statusSnapshot),
        message:
          rows.length > 0
            ? `Loaded ${rows.length} ${query ? "PR result" : "open PR"}(s).`
            : query
              ? "No PR results."
              : "No open PRs found.",
        activeUrl: this.rowUrl(rows[0]),
        isLandingView: !query,
      };
    }

    const searchQuery = query || "state:open";
    const issues = await this.service.searchIssues(searchQuery, this.browseLimit);
    const rows = issues.map((issue) => this.toIssueRow(issue));
    return {
      mode,
      rows,
      resultTitle: query ? `Issues · ${query}` : "Issues",
      detailTitle: "Start Here",
      detailText: query
        ? "Press Enter to open the selected issue detail."
        : formatSearchLandingDetail("issue-search", this.statusSnapshot),
      message:
        rows.length > 0
          ? `Loaded ${rows.length} ${query ? "issue result" : "open issue"}(s).`
          : query
            ? "No issue results."
            : "No open issues found.",
      activeUrl: this.rowUrl(rows[0]),
      isLandingView: !query,
    };
  }

  private async refreshDetailForSelection(
    force = false,
    focusSection: TuiDetailSection | null = null,
  ): Promise<void> {
    if (!this.showDetail && !force) {
      this.emit();
      return;
    }
    const row = this.rows[this.selectedIndex];
    if (!row) {
      this.loadLandingDetailForCurrentMode();
      this.detailIdentity = null;
      this.detailAnchorLine = null;
      this.detailAnchorKey = null;
      this.emit();
      return;
    }

    const requestId = ++this.detailRequestId;
    if (row.kind === "pr") {
      const bundle = await this.service.getPrContextBundle(row.pr.prNumber);
      if (requestId !== this.detailRequestId || !bundle) {
        return;
      }
      const formatted = formatPriorityPrDetail(bundle, focusSection);
      this.detailTitle = `PR #${bundle.candidate.pr.prNumber}`;
      this.detailText = formatted.text;
      this.detailIdentity = `pr:${bundle.candidate.pr.prNumber}`;
      this.detailStatus = `Freshness: ${this.rowFreshness(row).toUpperCase()}`;
      this.context = { kind: "pr", prNumber: bundle.candidate.pr.prNumber };
      this.activeUrl = bundle.candidate.pr.url;
      if (focusSection) {
        this.detailAnchorLine = formatted.anchorLine;
        this.detailAnchorKey = `${this.detailIdentity}:${focusSection}:${++this.detailAnchorNonce}`;
      } else {
        this.detailAnchorLine = null;
        this.detailAnchorKey = null;
      }
      this.emit();
      return;
    }

    if (row.kind === "issue") {
      const issue = await this.service.showIssue(row.issue.issueNumber);
      if (requestId !== this.detailRequestId || !issue) {
        return;
      }
      this.detailTitle = `Issue #${issue.issueNumber}`;
      this.detailText = formatIssueDetail(issue);
      this.detailIdentity = `issue:${issue.issueNumber}`;
      this.detailStatus = `Freshness: ${this.rowFreshness(row).toUpperCase()}`;
      this.context = { kind: "issue", issueNumber: issue.issueNumber };
      this.activeUrl = issue.url;
      this.detailAnchorLine = null;
      this.detailAnchorKey = null;
      this.emit();
      return;
    }

    if (row.kind === "status" && this.statusSnapshot) {
      this.detailTitle = "Repository Status";
      this.detailText = formatStatusDetail(this.statusSnapshot);
      this.detailStatus = null;
      this.detailIdentity = "status";
      this.detailAnchorLine = null;
      this.detailAnchorKey = null;
      this.activeUrl = null;
      this.emit();
    }
  }

  private async openPrDetailSection(section: TuiDetailSection): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row || row.kind !== "pr") {
      return;
    }
    this.showDetail = true;
    this.isLandingView = false;
    await this.refreshDetailForSelection(true, section);
  }

  private async refreshDetailForPr(prNumber: number, manual = false): Promise<void> {
    await this.runBusy(`Refreshing PR #${prNumber}`, async () => {
      this.syncMode = "detail";
      await this.service.refreshPrDetail(prNumber);
      this.detailFreshness.set(`pr:${prNumber}`, "fresh");
      await this.refreshStatus();
      if (manual && this.showDetail) {
        await this.refreshDetailForSelection(true);
      }
      this.message = `Refreshed PR #${prNumber}.`;
    });
    this.syncMode = null;
    this.emit();
  }

  private async refreshDetailForIssue(issueNumber: number, manual = false): Promise<void> {
    await this.runBusy(`Refreshing issue #${issueNumber}`, async () => {
      this.syncMode = "detail";
      await this.service.refreshIssueDetail(issueNumber);
      this.detailFreshness.set(`issue:${issueNumber}`, "fresh");
      await this.refreshStatus();
      if (manual && this.showDetail) {
        await this.refreshDetailForSelection(true);
      }
      this.message = `Refreshed issue #${issueNumber}.`;
    });
    this.syncMode = null;
    this.emit();
  }

  private async runBusy(label: string, task: () => Promise<void>): Promise<void> {
    if (this.busyMessage) {
      this.message = `Busy: ${this.busyMessage}`;
      this.emit();
      return;
    }
    this.busyMessage = label;
    this.errorMessage = null;
    this.emit();
    try {
      await task();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.message = "Operation failed.";
    } finally {
      this.busyMessage = null;
      this.emit();
    }
  }

  private toPrRow(
    pr: SearchResult,
    priority: Extract<TuiResultRow, { kind: "pr" }>["priority"] = null,
  ): Extract<TuiResultRow, { kind: "pr" }> {
    return {
      kind: "pr",
      pr,
      freshness: this.prFreshness(pr.updatedAt, `pr:${pr.prNumber}`),
      priority,
    };
  }

  private toIssueRow(issue: IssueSearchResult): Extract<TuiResultRow, { kind: "issue" }> {
    return {
      kind: "issue",
      issue,
      freshness: this.prFreshness(issue.updatedAt, `issue:${issue.issueNumber}`),
    };
  }

  private loadLandingDetailForCurrentMode(): void {
    if (this.mode === "inbox") {
      this.detailTitle = "Start Here";
      this.detailText = formatInboxLandingDetail(this.statusSnapshot);
      return;
    }
    if (this.mode === "watchlist") {
      this.detailTitle = "Start Here";
      this.detailText = formatWatchlistLandingDetail(this.statusSnapshot);
      return;
    }
    if (this.mode === "cross-search") {
      this.detailTitle = "Start Here";
      this.detailText = formatCrossSearchLandingDetail(this.statusSnapshot);
      return;
    }
    if (this.mode === "pr-search" || this.mode === "issue-search") {
      this.detailTitle = "Start Here";
      this.detailText = formatSearchLandingDetail(this.mode, this.statusSnapshot);
      return;
    }
    if (this.mode === "status" && this.statusSnapshot) {
      this.detailTitle = "Repository Status";
      this.detailText = formatStatusDetail(this.statusSnapshot);
    }
  }

  private availableFocuses(): TuiFocus[] {
    const focuses: TuiFocus[] = ["nav", "results"];
    if (this.showDetail) {
      focuses.push("detail");
    }
    if (this.isQueryMode(this.mode)) {
      focuses.push("query");
    }
    return focuses;
  }

  private isListMode(mode: TuiMode): mode is ListMode {
    return (
      mode === "inbox" ||
      mode === "watchlist" ||
      mode === "cross-search" ||
      mode === "pr-search" ||
      mode === "issue-search"
    );
  }

  private isQueryMode(mode: TuiMode): mode is SearchMode {
    return mode === "cross-search" || mode === "pr-search" || mode === "issue-search";
  }

  private crossSearchLimits(): { pr: number; issue: number } {
    const pages = Math.max(1, Math.ceil(this.browseLimit / DEFAULT_PAGE_SIZE));
    return {
      pr: CROSS_SEARCH_PAGE_SIZE.pr * pages,
      issue: CROSS_SEARCH_PAGE_SIZE.issue * pages,
    };
  }

  private currentBrowseCapacity(): number {
    if (this.mode === "cross-search") {
      const limits = this.crossSearchLimits();
      return limits.pr + limits.issue;
    }
    return this.browseLimit;
  }

  private canLoadMore(): boolean {
    return this.isListMode(this.mode) && this.rows.length >= this.currentBrowseCapacity();
  }

  async loadMore(): Promise<void> {
    if (!this.isListMode(this.mode)) {
      return;
    }
    const selectionIdentity = this.selectedRowIdentity();
    this.browseLimit += this.resultLimit;
    if (this.isQueryMode(this.mode) && this.query) {
      await this.submitQuery(this.query);
    } else {
      await this.loadLandingRows(this.mode);
    }
    this.restoreSelection(selectionIdentity);
    this.message = `Loaded up to ${this.browseLimit} rows.`;
    this.emit();
  }

  private prFreshness(updatedAt: string, key: string): TuiFreshness {
    const session = this.detailFreshness.get(key);
    if (session) {
      return session;
    }
    const ageMs = Date.now() - new Date(updatedAt).getTime();
    if (ageMs < 12 * 60 * 60 * 1000) {
      return "fresh";
    }
    if (ageMs > 7 * 24 * 60 * 60 * 1000) {
      return "stale";
    }
    return "partial";
  }

  private rowFreshness(row: Extract<TuiResultRow, { kind: "pr" | "issue" }>): TuiFreshness {
    return row.freshness;
  }

  private rowIdentity(row: Extract<TuiResultRow, { kind: "pr" | "issue" }>): string {
    return row.kind === "pr" ? `pr:${row.pr.prNumber}` : `issue:${row.issue.issueNumber}`;
  }

  private rowUrl(row: TuiResultRow | undefined): string | null {
    if (!row) {
      return null;
    }
    if (row.kind === "pr") {
      return row.pr.url;
    }
    if (row.kind === "issue") {
      return row.issue.url;
    }
    return null;
  }

  private selectedRowIdentity(): string | null {
    const row = this.rows[this.selectedIndex];
    if (!row) {
      return null;
    }
    if (row.kind === "pr") {
      return `pr:${row.pr.prNumber}`;
    }
    if (row.kind === "issue") {
      return `issue:${row.issue.issueNumber}`;
    }
    return row.kind;
  }

  private restoreSelection(selectionIdentity: string | null): void {
    if (!selectionIdentity) {
      return;
    }
    const nextIndex = this.rows.findIndex(
      (row) => this.rowIdentityForAny(row) === selectionIdentity,
    );
    if (nextIndex >= 0) {
      this.selectedIndex = nextIndex;
      this.activeUrl = this.rowUrl(this.rows[this.selectedIndex]);
      return;
    }
    if (this.rows.length > 0) {
      this.selectedIndex = Math.min(this.selectedIndex, this.rows.length - 1);
      this.activeUrl = this.rowUrl(this.rows[this.selectedIndex]);
    }
  }

  private rowIdentityForAny(row: TuiResultRow): string | null {
    if (row.kind === "pr") {
      return `pr:${row.pr.prNumber}`;
    }
    if (row.kind === "issue") {
      return `issue:${row.issue.issueNumber}`;
    }
    return row.kind;
  }

  private scheduleAutoSync(mode: ListMode): void {
    for (const entity of this.entitiesForMode(mode)) {
      if (this.isMetadataStale(entity, ENTRY_STALE_MS)) {
        this.queueMetadataSync(entity, "auto");
      }
    }
  }

  private entitiesForMode(mode: ListMode): MetadataEntity[] {
    if (mode === "issue-search") {
      return ["issues"];
    }
    if (mode === "cross-search") {
      return ["prs", "issues"];
    }
    return ["prs"];
  }

  private isMetadataStale(entity: MetadataEntity, thresholdMs: number): boolean {
    const value =
      entity === "prs"
        ? (this.statusSnapshot?.lastSyncAt ?? null)
        : (this.statusSnapshot?.issueLastSyncAt ?? null);
    if (!value) {
      return true;
    }
    return Date.now() - new Date(value).getTime() > thresholdMs;
  }

  private queueMetadataSync(entity: MetadataEntity, trigger: "auto" | "manual"): void {
    const job = this.syncJobs[entity];
    if (trigger === "manual") {
      this.manualPriority.add(entity);
    }
    job.nextAutoUpdateAt = null;
    job.errorMessage = null;
    if (job.state === "running") {
      job.pendingRerun = true;
      this.message = `${entity === "prs" ? "PR" : "Issue"} metadata sync will rerun after the current job.`;
      this.emit();
      return;
    }
    if (job.state === "queued") {
      this.emit();
      return;
    }
    job.state = "queued";
    this.message =
      trigger === "manual"
        ? `Queued ${entity === "prs" ? "PR" : "issue"} metadata sync.`
        : `Showing cached ${entity === "prs" ? "PR" : "issue"} rows while background sync runs.`;
    this.emit();
    void this.drainMetadataJobs();
  }

  private nextQueuedMetadataEntity(): MetadataEntity | null {
    for (const entity of ["prs", "issues"] as const) {
      if (this.manualPriority.has(entity) && this.syncJobs[entity].state === "queued") {
        return entity;
      }
    }
    for (const entity of ["prs", "issues"] as const) {
      if (this.syncJobs[entity].state === "queued") {
        return entity;
      }
    }
    return null;
  }

  private async drainMetadataJobs(): Promise<void> {
    if (this.activeMetadataJob) {
      return;
    }
    const nextEntity = this.nextQueuedMetadataEntity();
    if (!nextEntity) {
      return;
    }
    const job = this.syncJobs[nextEntity];
    this.activeMetadataJob = nextEntity;
    this.manualPriority.delete(nextEntity);
    job.state = "running";
    job.progress = {
      entity: nextEntity,
      phase: "discovering",
      processed: 0,
      skipped: 0,
      queued: 0,
      totalKnown: null,
      currentId: null,
      currentTitle: null,
    };
    this.emit();

    try {
      const summary =
        nextEntity === "prs"
          ? await this.service.syncPrs({
              onProgress: (event) => this.handleMetadataProgress(nextEntity, event),
            })
          : await this.service.syncIssues({
              onProgress: (event) => this.handleMetadataProgress(nextEntity, event),
            });
      await this.refreshStatus();
      job.state = "cooldown";
      job.progress = {
        entity: nextEntity,
        phase: "complete",
        processed: nextEntity === "prs" ? summary.processedPrs : summary.processedIssues,
        skipped: nextEntity === "prs" ? summary.skippedPrs : summary.skippedIssues,
        queued: 0,
        totalKnown:
          summary.mode === "incremental"
            ? nextEntity === "prs"
              ? summary.processedPrs + summary.skippedPrs
              : summary.processedIssues + summary.skippedIssues
            : null,
        currentId: null,
        currentTitle: null,
      };
      job.lastCompletedAt = summary.lastSyncAt;
      job.nextAutoUpdateAt = new Date(Date.now() + IDLE_INTERVAL_MS).toISOString();
      this.message = `Synced ${nextEntity === "prs" ? "PR" : "issue"} metadata: processed ${job.progress.processed}, skipped ${job.progress.skipped}.`;
      this.scheduleListReplay();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.state = "error";
      job.errorMessage = message;
      this.message = `${nextEntity === "prs" ? "PR" : "Issue"} metadata sync failed: ${message}`;
    } finally {
      this.activeMetadataJob = null;
      if (job.pendingRerun) {
        job.pendingRerun = false;
        job.state = "queued";
      }
      this.emit();
      if (this.nextQueuedMetadataEntity()) {
        void this.drainMetadataJobs();
      }
    }
  }

  private handleMetadataProgress(entity: MetadataEntity, event: SyncProgressEvent): void {
    const job = this.syncJobs[entity];
    job.progress = event;
    job.state = "running";
    const label = entity === "prs" ? "PR" : "issue";
    const progressLabel =
      event.totalKnown === null
        ? `${event.processed}+${event.skipped}`
        : `${event.processed}/${event.totalKnown}`;
    const current = event.currentId !== null ? `, now on #${event.currentId}` : "";
    this.message = `Syncing ${label} metadata: ${progressLabel}${current}`;
    this.emit();
  }

  private ensureIdleRefreshTimer(): void {
    if (this.idleRefreshTimer) {
      return;
    }
    this.idleRefreshTimer = setInterval(() => {
      void this.maybeQueueIdleRefresh();
    }, 1000);
    this.idleRefreshTimer.unref?.();
  }

  private async maybeQueueIdleRefresh(): Promise<void> {
    if (Date.now() - this.lastInteractionAt < IDLE_TIMEOUT_MS) {
      return;
    }
    for (const entity of ["prs", "issues"] as const) {
      const nextAt = this.syncJobs[entity].nextAutoUpdateAt;
      if (nextAt && new Date(nextAt).getTime() <= Date.now()) {
        this.queueMetadataSync(entity, "auto");
      }
    }
  }

  private scheduleListReplay(): void {
    if (this.replayTimer) {
      clearTimeout(this.replayTimer);
    }
    this.replayTimer = setTimeout(() => {
      void this.refreshActiveListPreservingUi();
    }, REPLAY_DEBOUNCE_MS);
    this.replayTimer.unref?.();
  }

  private async refreshActiveListPreservingUi(): Promise<void> {
    if (!this.isListMode(this.mode)) {
      return;
    }
    const selectionIdentity = this.selectedRowIdentity();
    const requestId = ++this.listRequestId;
    const result = await this.resolveListRows(
      this.mode,
      this.isQueryMode(this.mode) ? this.query : "",
    );
    if (requestId !== this.listRequestId || this.mode !== result.mode) {
      return;
    }
    this.applyListResult(result);
    this.context = null;
    this.restoreSelection(selectionIdentity);
    if (this.showDetail && this.rows[this.selectedIndex]) {
      await this.refreshDetailForSelection(true);
      return;
    }
    this.showDetail = false;
    this.detailStatus = null;
    this.detailIdentity = null;
    this.detailAnchorLine = null;
    this.detailAnchorKey = null;
    if (this.focus === "detail") {
      this.focus = "results";
    }
    this.loadLandingDetailForCurrentMode();
    this.emit();
  }

  private modeLabel(mode: TuiMode): string {
    return TUI_MODE_ORDER.find((item) => item.id === mode)?.label ?? "Results";
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
