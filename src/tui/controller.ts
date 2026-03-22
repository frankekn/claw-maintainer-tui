import { buildStatusRows } from "./format.js";
import { TuiEffects } from "./effects.js";
import { buildListSummary, currentBrowseCapacity, resolveListRows } from "./listing.js";
import {
  computePrFreshness,
  rowFreshness,
  rowIdentity,
  rowIdentityForAny,
  rowUrl,
  selectedRowIdentity,
} from "./rows.js";
import type {
  ListLoadResult,
  ListMode,
  MetadataEntity,
  PriorityMode,
  SearchMode,
} from "./types.js";
import { buildRenderModel } from "./presenter.js";
import {
  availableFocuses,
  createInitialSessionState,
  createLandingDetailState,
  createViewSnapshot,
} from "./state.js";
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
  TuiCommand,
  TuiContext,
  TuiDetailState,
  TuiDetailSection,
  TuiFocus,
  TuiFreshness,
  TuiMode,
  TuiRenderModel,
  TuiResultRow,
  TuiSessionState,
  TuiSyncJobSnapshot,
  TuiSyncMode,
} from "./types.js";

type ControllerOptions = {
  repo: string;
  dbPath: string;
  ftsOnly: boolean;
  resultLimit?: number;
};

const PRIORITY_SCAN_LIMIT = 300;
const DEFAULT_PAGE_SIZE = 20;
const ENTRY_STALE_MS = 10 * 60 * 1000;
const IDLE_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_TIMEOUT_MS = 30 * 1000;
const REPLAY_DEBOUNCE_MS = 150;

export class TuiController {
  private readonly listeners = new Set<() => void>();
  private readonly resultLimit: number;
  private readonly effects: TuiEffects;
  private readonly sessionState: TuiSessionState;
  private detailState: TuiDetailState;
  private statusSnapshot: StatusSnapshot | null = null;
  private detailAnchorNonce = 0;
  private busyMessage: string | null = null;
  private syncMode: TuiSyncMode | null = null;
  private detailRequestId = 0;
  private listRequestId = 0;
  private detailAutoRefreshInFlight = false;
  private readonly detailFreshness = new Map<string, TuiFreshness>();
  private rateLimitSnapshot: Awaited<ReturnType<TuiEffects["rateLimit"]>> = null;
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
  private disposed = false;

  constructor(
    service: TuiEffects | ConstructorParameters<typeof TuiEffects>[0],
    private readonly options: ControllerOptions,
  ) {
    this.resultLimit = options.resultLimit ?? DEFAULT_PAGE_SIZE;
    this.effects = service instanceof TuiEffects ? service : new TuiEffects(service);
    this.sessionState = createInitialSessionState(this.resultLimit);
    this.detailState = createLandingDetailState("inbox", null);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getRenderModel(): TuiRenderModel {
    return buildRenderModel(this.sessionState, this.detailState, {
      repo: this.options.repo,
      dbPath: this.options.dbPath,
      ftsOnly: this.options.ftsOnly,
      status: this.statusSnapshot,
      rateLimit: this.rateLimitSnapshot,
      syncMode: this.syncMode,
      syncJobs: Object.values(this.syncJobs),
      detailAutoRefreshInFlight: this.detailAutoRefreshInFlight,
      busyMessage: this.busyMessage,
      errorMessage: this.errorMessage,
      actions: this.buildActions(),
      listSummary: buildListSummary({
        mode: this.mode,
        rows: this.rows,
        browseLimit: this.browseLimit,
      }),
      canLoadMore: this.canLoadMore(),
    });
  }

  private get mode(): TuiMode {
    return this.sessionState.mode;
  }

  private set mode(value: TuiMode) {
    this.sessionState.mode = value;
  }

  private get focus(): TuiFocus {
    return this.sessionState.focus;
  }

  private set focus(value: TuiFocus) {
    this.sessionState.focus = value;
  }

  private get rows(): TuiResultRow[] {
    return this.sessionState.rows;
  }

  private set rows(value: TuiResultRow[]) {
    this.sessionState.rows = value;
  }

  private get selectedIndex(): number {
    return this.sessionState.selectedIndex;
  }

  private set selectedIndex(value: number) {
    this.sessionState.selectedIndex = value;
  }

  private get activeUrl(): string | null {
    return this.sessionState.activeUrl;
  }

  private set activeUrl(value: string | null) {
    this.sessionState.activeUrl = value;
  }

  private get query(): string {
    return this.sessionState.query;
  }

  private set query(value: string) {
    this.sessionState.query = value;
  }

  private get context(): TuiContext {
    return this.sessionState.context;
  }

  private set context(value: TuiContext) {
    this.sessionState.context = value;
  }

  private get resultTitle(): string {
    return this.sessionState.resultTitle;
  }

  private set resultTitle(value: string) {
    this.sessionState.resultTitle = value;
  }

  private get message(): string {
    return this.sessionState.message;
  }

  private set message(value: string) {
    this.sessionState.message = value;
  }

  private get errorMessage(): string | null {
    return this.sessionState.errorMessage;
  }

  private set errorMessage(value: string | null) {
    this.sessionState.errorMessage = value;
  }

  private get browseLimit(): number {
    return this.sessionState.browseLimit;
  }

  private set browseLimit(value: number) {
    this.sessionState.browseLimit = value;
  }

  private get isLandingView(): boolean {
    return this.sessionState.isLandingView;
  }

  private set isLandingView(value: boolean) {
    this.sessionState.isLandingView = value;
  }

  private get history() {
    return this.sessionState.history;
  }

  private get showDetail(): boolean {
    return this.detailState.visible;
  }

  private set showDetail(value: boolean) {
    this.detailState.visible = value;
  }

  private get detailStatus(): string | null {
    return this.detailState.status;
  }

  private set detailStatus(value: string | null) {
    this.detailState.status = value;
  }

  private get detailIdentity(): string | null {
    return this.detailState.identity;
  }

  private set detailIdentity(value: string | null) {
    this.detailState.identity = value;
  }

  private get detailAnchorKey(): string | null {
    return this.detailState.anchorKey;
  }

  private set detailAnchorKey(value: string | null) {
    this.detailState.anchorKey = value;
  }

  private get detailFocusSection(): TuiDetailSection | null {
    return this.detailState.focusSection;
  }

  private set detailFocusSection(value: TuiDetailSection | null) {
    this.detailState.focusSection = value;
  }

  private resetDetailState(mode = this.mode): void {
    this.detailRequestId += 1;
    this.detailState = createLandingDetailState(mode, this.statusSnapshot);
  }

  private setDetailPayload(next: TuiDetailState): void {
    this.detailState = next;
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

  dispose(): void {
    this.disposed = true;
    this.detailRequestId += 1;
    this.listRequestId += 1;
    this.detailAutoRefreshInFlight = false;
    if (this.idleRefreshTimer) {
      clearInterval(this.idleRefreshTimer);
      this.idleRefreshTimer = null;
    }
    if (this.replayTimer) {
      clearTimeout(this.replayTimer);
      this.replayTimer = null;
    }
  }

  reportError(message: string, context = "Operation"): void {
    this.errorMessage = message;
    this.message = `${context} failed.`;
    this.emit();
  }

  async replayActiveList(): Promise<void> {
    await this.refreshActiveListPreservingUi();
  }

  noteInteraction(): void {
    this.lastInteractionAt = Date.now();
  }

  async dispatch(command: TuiCommand): Promise<void> {
    switch (command.type) {
      case "focus_next":
        this.focusNext();
        return;
      case "focus_results":
        this.focusResults();
        return;
      case "activate_mode":
        this.moveMode(command.delta);
        return;
      case "move_selection":
        this.moveSelection(command.delta);
        return;
      case "toggle_detail":
        await this.openSelected();
        return;
      case "expand_cluster":
        await this.expandSelectedCluster();
        return;
      case "jump_detail_section":
        if (command.section === "linked-issues") {
          await this.crossReferenceSelected();
          return;
        }
        await this.clusterSelected();
        return;
      case "start_query":
        this.startQueryEntry();
        return;
      case "stop_query":
        this.stopQueryEntry();
        return;
      case "append_query":
        this.appendQueryCharacter(command.value);
        return;
      case "backspace_query":
        this.backspaceQuery();
        return;
      case "submit_query":
        await this.submitCurrentQuery();
        return;
      case "trigger_action":
        await this.triggerAction(command.slot);
        return;
      case "go_back":
        this.goBack();
        return;
      case "mark_seen":
        await this.markSeenSelected();
        return;
      case "toggle_watch":
        await this.toggleWatchSelected();
        return;
      case "toggle_ignore":
        await this.toggleIgnoreSelected();
        return;
      case "clear_attention_state":
        await this.clearSelectedAttentionState();
        return;
      case "sync_prs":
        await this.syncPrs();
        return;
      case "sync_issues":
        await this.syncIssues();
        return;
      case "refresh_selected":
        await this.refreshSelected();
        return;
      case "load_more":
        await this.loadMore();
        return;
      default:
        return;
    }
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
    this.resetDetailState(mode);
    this.detailAutoRefreshInFlight = false;
    this.context = null;
    this.activeUrl = null;
    this.query = "";
    this.browseLimit = this.resultLimit;
    this.errorMessage = null;
    this.isLandingView = false;
    this.resultTitle = this.modeLabel(mode);
    this.message = this.isListMode(mode)
      ? `Loading ${this.modeLabel(mode)}...`
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
      this.detailState = createLandingDetailState("status", this.statusSnapshot);
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
    this.resetDetailState(this.mode);
    this.activeUrl = null;
    const requestId = ++this.listRequestId;
    if (!this.query) {
      await this.loadLandingRows(mode);
      return;
    }
    await this.runBusy(`Searching ${this.modeLabel(mode)}`, async () => {
      const result = await this.resolveRows(mode, this.query);
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
      this.resetDetailState(this.mode);
      this.loadLandingDetailForCurrentMode();
      this.focus = "results";
      this.message = "Closed detail drawer.";
      this.emit();
      return;
    }
    this.showDetail = true;
    this.isLandingView = false;
    await this.refreshDetailForSelection(true, row.kind === "priority-cluster" ? "cluster" : null);
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
      case "expand-cluster":
        await this.expandSelectedCluster();
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
    if (!row || (row.kind !== "pr" && row.kind !== "priority-cluster")) {
      return;
    }
    await this.openPrDetailSection("cluster");
  }

  async expandSelectedCluster(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row || row.kind !== "priority-cluster") {
      return;
    }
    this.pushHistory();
    this.rows = row.cluster.openMembers.map((member) => this.toPrRow(member.pr, member));
    this.selectedIndex = 0;
    this.resultTitle = `Cluster · ${row.cluster.statusLabel}`;
    this.message = `Expanded ${row.cluster.openMembers.length} open PR(s) from ${row.cluster.statusLabel}.`;
    this.activeUrl = this.rowUrl(this.rows[0]);
    this.isLandingView = false;
    this.resetDetailState(this.mode);
    this.focus = "results";
    this.emit();
  }

  async markSeenSelected(): Promise<void> {
    await this.updateAttentionState("seen", "Marked PR as seen.");
  }

  async toggleWatchSelected(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row || (row.kind !== "pr" && row.kind !== "priority-cluster")) {
      return;
    }
    const current =
      row.kind === "pr"
        ? await this.currentAttentionState(row.pr.prNumber, row.priority?.attentionState)
        : this.clusterAttentionState(row);
    await this.updateAttentionState(
      current === "watch" ? null : "watch",
      current === "watch" ? "Cleared watch state." : "Added PR to watchlist.",
    );
  }

  async toggleIgnoreSelected(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row || (row.kind !== "pr" && row.kind !== "priority-cluster")) {
      return;
    }
    const current =
      row.kind === "pr"
        ? await this.currentAttentionState(row.pr.prNumber, row.priority?.attentionState)
        : this.clusterAttentionState(row);
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
    this.mode = snapshot.session.mode;
    this.query = snapshot.session.query;
    this.rows = snapshot.session.rows;
    this.selectedIndex = snapshot.session.selectedIndex;
    this.activeUrl = snapshot.session.activeUrl;
    this.resultTitle = snapshot.session.resultTitle;
    this.context = snapshot.session.context;
    this.isLandingView = snapshot.session.isLandingView;
    this.browseLimit = snapshot.session.browseLimit;
    this.setDetailPayload(snapshot.detail);
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
    if (row.kind === "priority-cluster") {
      await this.refreshPriorityCluster(row.cluster);
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

  private async refreshPriorityCluster(
    cluster: Extract<TuiResultRow, { kind: "priority-cluster" }>["cluster"],
  ): Promise<void> {
    await this.runBusy(`Refreshing cluster ${cluster.statusLabel}`, async () => {
      this.syncMode = "detail";
      await this.effects.refreshPrDetail(cluster.representative.pr.prNumber);
      this.detailFreshness.set(`pr:${cluster.representative.pr.prNumber}`, "fresh");
      await this.refreshStatus();
      await this.refreshActiveListPreservingUi();
      this.message = `Refreshed cluster anchored on PR #${cluster.representative.pr.prNumber}.`;
    });
    this.syncMode = null;
    this.emit();
  }

  private async updateAttentionState(state: AttentionState | null, message: string): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row) {
      return;
    }
    if (row.kind === "pr") {
      await this.effects.setPrAttentionState(row.pr.prNumber, state);
    } else if (row.kind === "priority-cluster") {
      await Promise.all(
        row.cluster.openMembers.map((member) =>
          this.effects.setPrAttentionState(member.pr.prNumber, state),
        ),
      );
    } else {
      return;
    }
    this.message = message;
    await this.refreshActiveListPreservingUi();
  }

  private clusterAttentionState(
    row: Extract<TuiResultRow, { kind: "priority-cluster" }>,
  ): PriorityAttentionState | "mixed" {
    const states = new Set(
      row.cluster.openMembers
        .map((member) => member.attentionState)
        .filter((value) => value !== "new"),
    );
    if (states.size === 0) {
      return "new";
    }
    if (states.size > 1) {
      return "mixed";
    }
    return states.values().next().value as PriorityAttentionState;
  }

  private async currentAttentionState(
    prNumber: number,
    fromRow: PriorityAttentionState | null | undefined,
  ): Promise<PriorityAttentionState> {
    if (fromRow) {
      return fromRow;
    }
    const bundle = await this.effects.getPrContextBundle(prNumber);
    return bundle?.candidate.attentionState ?? "new";
  }

  private buildActions(): TuiAction[] {
    const row = this.rows[this.selectedIndex];
    const hasRow = Boolean(row);
    const hasHistory = this.history.length > 0;
    const canLinked = row?.kind === "pr";
    const canCluster = row?.kind === "pr" || row?.kind === "priority-cluster";
    const canExpand = row?.kind === "priority-cluster";
    const canTriage = row?.kind === "pr" || row?.kind === "priority-cluster";
    const canRefresh =
      row?.kind === "pr" || row?.kind === "issue" || row?.kind === "priority-cluster";
    const hasLocalState =
      row?.kind === "pr"
        ? (row.priority?.attentionState ?? "new") !== "new"
        : row?.kind === "priority-cluster"
          ? this.clusterAttentionState(row) !== "new"
          : false;

    switch (this.mode) {
      case "inbox":
      case "watchlist":
        return [
          this.action(1, "detail", this.showDetail ? "Close" : "Detail", "Enter", hasRow),
          this.action(
            2,
            row?.kind === "priority-cluster" ? "expand-cluster" : "jump-linked-issues",
            row?.kind === "priority-cluster" ? "Expand" : "Linked",
            row?.kind === "priority-cluster" ? "e" : "x",
            row?.kind === "priority-cluster" ? canExpand : canLinked,
          ),
          this.action(3, "cluster", "Cluster", "c", canCluster),
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
          this.action(3, "jump-linked-issues", "Linked", "x", canLinked),
          this.action(4, "cluster", "Cluster", "c", canCluster),
          this.action(5, "sync-prs", "Sync PRs", "s"),
          this.action(6, "sync-issues", "Sync Issues", "S"),
          this.action(7, "refresh", "Refresh", "r", canRefresh),
          this.action(8, "load-more", "More", "m", this.canLoadMore()),
        ];
      case "pr-search":
        return [
          this.action(1, "query", "Search", "/"),
          this.action(2, "detail", this.showDetail ? "Close" : "Detail", "Enter", hasRow),
          this.action(3, "jump-linked-issues", "Linked", "x", canLinked),
          this.action(4, "cluster", "Cluster", "c", canCluster),
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
    this.history.push(createViewSnapshot(this.sessionState, this.detailState));
  }

  private async refreshStatus(): Promise<void> {
    this.statusSnapshot = await this.effects.status();
    try {
      this.rateLimitSnapshot = await this.effects.rateLimit();
    } catch {
      this.rateLimitSnapshot = this.rateLimitSnapshot ?? null;
    }
    if (this.mode === "status" && this.statusSnapshot) {
      this.rows = buildStatusRows(this.statusSnapshot);
      this.detailState = createLandingDetailState("status", this.statusSnapshot);
    }
  }

  private async loadLandingRows(mode: ListMode): Promise<void> {
    const requestId = ++this.listRequestId;
    this.isLandingView = true;
    this.resetDetailState(mode);
    this.message = `Loading ${this.modeLabel(mode)}...`;
    this.emit();
    try {
      const result = await this.resolveRows(mode, "");
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
    this.message = result.message;
    this.activeUrl = result.activeUrl;
    this.isLandingView = result.isLandingView;
    this.resetDetailState(result.mode);
  }

  private async resolveRows(mode: ListMode, query: string): Promise<ListLoadResult> {
    return resolveListRows({
      mode,
      query,
      browseLimit: this.browseLimit,
      listPriorityInbox: (options) => this.effects.listPriorityInbox(options),
      listPriorityQueue: (options) => this.effects.listPriorityQueue(options),
      listWatchlist: (limit) => this.effects.listWatchlist(limit),
      search: (searchQuery, limit) => this.effects.search(searchQuery, limit),
      searchIssues: (searchQuery, limit) => this.effects.searchIssues(searchQuery, limit),
      toPrRow: (pr, priority = null) => this.toPrRow(pr, priority),
      toPriorityClusterRow: (cluster) => this.toPriorityClusterRow(cluster),
      toIssueRow: (issue) => this.toIssueRow(issue),
      rowUrl: (row) => this.rowUrl(row),
      priorityScanLimit: PRIORITY_SCAN_LIMIT,
    });
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
      this.detailAnchorKey = null;
      this.detailFocusSection = null;
      this.emit();
      return;
    }

    const requestId = ++this.detailRequestId;
    this.detailAutoRefreshInFlight = true;
    this.emit();
    try {
      if (row.kind === "pr") {
        const bundle = await this.effects.getPrContextBundle(row.pr.prNumber);
        if (requestId !== this.detailRequestId || !bundle) {
          return;
        }
        this.setDetailPayload({
          visible: true,
          payload: { kind: "pr", bundle },
          identity: `pr:${bundle.candidate.pr.prNumber}`,
          status: `Freshness: ${this.rowFreshness(row).toUpperCase()}`,
          focusSection,
          anchorKey: focusSection
            ? `pr:${bundle.candidate.pr.prNumber}:${focusSection}:${++this.detailAnchorNonce}`
            : null,
        });
        this.context = { kind: "pr", prNumber: bundle.candidate.pr.prNumber };
        this.activeUrl = bundle.candidate.pr.url;
        this.emit();
        return;
      }

      if (row.kind === "priority-cluster") {
        const bundle = await this.effects.getPrContextBundle(
          row.cluster.representative.pr.prNumber,
        );
        if (requestId !== this.detailRequestId || !bundle) {
          return;
        }
        const targetSection = focusSection ?? "cluster";
        this.setDetailPayload({
          visible: true,
          payload: { kind: "pr", bundle },
          identity: row.cluster.clusterKey,
          status: `${row.cluster.statusLabel} · ${row.cluster.openPrCount} open / ${row.cluster.totalPrCount} total`,
          focusSection: targetSection,
          anchorKey: `${row.cluster.clusterKey}:${targetSection}:${++this.detailAnchorNonce}`,
        });
        this.context = { kind: "pr", prNumber: bundle.candidate.pr.prNumber };
        this.activeUrl = row.cluster.representative.pr.url;
        this.emit();
        return;
      }

      if (row.kind === "issue") {
        const issue = await this.effects.showIssue(row.issue.issueNumber);
        if (requestId !== this.detailRequestId || !issue) {
          return;
        }
        this.setDetailPayload({
          visible: true,
          payload: { kind: "issue", issue },
          identity: `issue:${issue.issueNumber}`,
          status: `Freshness: ${this.rowFreshness(row).toUpperCase()}`,
          focusSection: null,
          anchorKey: null,
        });
        this.context = { kind: "issue", issueNumber: issue.issueNumber };
        this.activeUrl = issue.url;
        this.emit();
        return;
      }

      if (row.kind === "status" && this.statusSnapshot) {
        this.setDetailPayload({
          visible: true,
          payload: { kind: "status", status: this.statusSnapshot },
          identity: "status",
          status: null,
          focusSection: null,
          anchorKey: null,
        });
        this.activeUrl = null;
        this.emit();
      }
    } catch (error) {
      if (requestId !== this.detailRequestId) {
        return;
      }
      this.reportError(error instanceof Error ? error.message : String(error), "Detail load");
    } finally {
      if (requestId === this.detailRequestId) {
        this.detailAutoRefreshInFlight = false;
        this.emit();
      }
    }
  }

  private async openPrDetailSection(section: TuiDetailSection): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row || (row.kind !== "pr" && row.kind !== "priority-cluster")) {
      return;
    }
    this.showDetail = true;
    this.isLandingView = false;
    await this.refreshDetailForSelection(true, section);
  }

  private async refreshDetailForPr(prNumber: number, manual = false): Promise<void> {
    await this.runBusy(`Refreshing PR #${prNumber}`, async () => {
      this.syncMode = "detail";
      await this.effects.refreshPrDetail(prNumber);
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
      await this.effects.refreshIssueDetail(issueNumber);
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

  private toPriorityClusterRow(
    cluster: Extract<TuiResultRow, { kind: "priority-cluster" }>["cluster"],
  ): Extract<TuiResultRow, { kind: "priority-cluster" }> {
    return {
      kind: "priority-cluster",
      cluster,
      freshness: this.prFreshness(
        cluster.representative.pr.updatedAt,
        `pr:${cluster.representative.pr.prNumber}`,
      ),
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
    this.resetDetailState(this.mode);
  }

  private availableFocuses(): TuiFocus[] {
    return availableFocuses(this.sessionState, this.detailState);
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

  private canLoadMore(): boolean {
    return (
      this.isListMode(this.mode) &&
      this.rows.length >= currentBrowseCapacity(this.mode, this.browseLimit)
    );
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
    return computePrFreshness({
      updatedAt,
      key,
      detailFreshness: this.detailFreshness,
    });
  }

  private rowFreshness(
    row: Extract<TuiResultRow, { kind: "pr" | "issue" | "priority-cluster" }>,
  ): TuiFreshness {
    return rowFreshness(row);
  }

  private rowIdentity(
    row: Extract<TuiResultRow, { kind: "pr" | "issue" | "priority-cluster" }>,
  ): string {
    return rowIdentity(row);
  }

  private rowUrl(row: TuiResultRow | undefined): string | null {
    return rowUrl(row);
  }

  private selectedRowIdentity(): string | null {
    return selectedRowIdentity(this.rows, this.selectedIndex);
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
    return rowIdentityForAny(row);
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
          ? await this.effects.syncPrs({
              onProgress: (event) => this.handleMetadataProgress(nextEntity, event),
            })
          : await this.effects.syncIssues({
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
    if (this.disposed) {
      return;
    }
    if (!this.isListMode(this.mode)) {
      return;
    }
    const selectionIdentity = this.selectedRowIdentity();
    const requestId = ++this.listRequestId;
    const result = await this.resolveRows(this.mode, this.isQueryMode(this.mode) ? this.query : "");
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
    this.resetDetailState(this.mode);
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
    if (this.disposed) {
      return;
    }
    for (const listener of this.listeners) {
      listener();
    }
  }
}
