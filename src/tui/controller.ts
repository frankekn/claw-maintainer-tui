import {
  buildStatusRows,
  defaultSecondaryHintText,
  formatClusterDetail,
  formatClusterLandingDetail,
  formatCrossSearchLandingDetail,
  formatIssueDetail,
  formatPrDetail,
  formatSearchLandingDetail,
  formatStatusDetail,
} from "./format.js";
import { TUI_MODE_ORDER } from "./types.js";
import type {
  ClusterPullRequestAnalysis,
  IssueSearchResult,
  SearchResult,
  StatusSnapshot,
} from "../types.js";
import type {
  TuiAction,
  TuiActionId,
  TuiClusterVerificationSummary,
  TuiContext,
  TuiDataService,
  TuiFocus,
  TuiFreshness,
  TuiListSummary,
  TuiMode,
  TuiRenderModel,
  TuiResultRow,
  TuiSyncMode,
  TuiVerificationState,
  TuiViewSnapshot,
} from "./types.js";

type ControllerOptions = {
  repo: string;
  dbPath: string;
  ftsOnly: boolean;
  resultLimit?: number;
};

type ClusterContextState = {
  analysis: ClusterPullRequestAnalysis;
  seedLabel: string;
  verificationSummary: TuiClusterVerificationSummary | null;
};

type DetailRefreshTarget = { kind: "pr"; id: number } | { kind: "issue"; id: number } | null;

const CROSS_SEARCH_LIMITS = {
  pr: 8,
  issue: 6,
  cluster: 6,
} as const;

export class TuiController {
  private readonly listeners = new Set<() => void>();
  private readonly resultLimit: number;
  private statusSnapshot: StatusSnapshot | null = null;
  private mode: TuiMode = "cross-search";
  private focus: TuiFocus = "results";
  private rows: TuiResultRow[] = [];
  private selectedIndex = 0;
  private detailText = "Search once to scan PRs, issues, and cluster signals together.";
  private detailTitle = "Start Here";
  private detailStatus: string | null = null;
  private showDetail = false;
  private resultTitle = "Cross Search";
  private activeUrl: string | null = null;
  private query = "";
  private context: TuiContext = null;
  private busyMessage: string | null = null;
  private syncMode: TuiSyncMode | null = null;
  private errorMessage: string | null = null;
  private message = "Ready.";
  private readonly history: TuiViewSnapshot[] = [];
  private detailRequestId = 0;
  private listRequestId = 0;
  private clusterContext: ClusterContextState | null = null;
  private isLandingView = false;
  private detailAutoRefreshInFlight = false;
  private detailRefreshTarget: DetailRefreshTarget = null;
  private readonly detailFreshness = new Map<string, TuiFreshness>();
  private readonly clusterVerification = new Map<number, TuiClusterVerificationSummary>();
  private rateLimitSnapshot: Awaited<ReturnType<TuiDataService["rateLimit"]>> = null;

  constructor(
    private readonly service: TuiDataService,
    private readonly options: ControllerOptions,
  ) {
    this.resultLimit = options.resultLimit ?? 20;
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
        detailAutoRefreshInFlight: this.detailAutoRefreshInFlight,
        busyMessage: this.busyMessage,
        errorMessage: this.errorMessage,
      },
      footer: {
        hintText: defaultSecondaryHintText(),
        message: this.errorMessage ?? this.message,
        queryPrompt: modeInfo.queryPrompt,
        queryValue: this.query,
        actions: this.buildActions(),
      },
      mode: this.mode,
      focus: this.focus,
      rows: this.rows,
      selectedIndex: this.selectedIndex,
      detailText: this.detailText,
      detailStatus: this.detailStatus,
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
    await this.refreshStatus();
    await this.loadLandingRows("cross-search");
    this.emit();
  }

  focusNext(): void {
    const order: TuiFocus[] = ["nav", "results", "query"];
    const nextIndex = (order.indexOf(this.focus) + 1) % order.length;
    this.focus = order[nextIndex]!;
    this.emit();
  }

  activateMode(mode: TuiMode): void {
    if (mode === this.mode) {
      this.message = `Switched to ${this.modeLabel(mode)}.`;
      this.emit();
      return;
    }
    this.mode = mode;
    this.rows = [];
    this.selectedIndex = 0;
    this.showDetail = false;
    this.detailStatus = null;
    this.detailAutoRefreshInFlight = false;
    this.detailRefreshTarget = null;
    this.clusterContext = null;
    this.context = null;
    this.activeUrl = null;
    this.query = "";
    this.errorMessage = null;
    this.isLandingView = false;
    this.resultTitle = this.modeLabel(mode);
    this.detailTitle = "Start Here";
    this.detailText =
      mode === "status"
        ? this.statusSnapshot
          ? formatStatusDetail(this.statusSnapshot)
          : "Loading repository status..."
        : `Switched to ${this.modeLabel(mode)}.`;
    this.message = `Switched to ${this.modeLabel(mode)}.`;
    this.emit();
    if (mode === "cross-search" || mode === "pr-search" || mode === "issue-search") {
      void this.loadLandingRows(mode);
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

  isQueryFocus(): boolean {
    return this.focus === "query";
  }

  isNavFocus(): boolean {
    return this.focus === "nav";
  }

  startQueryEntry(): void {
    if (this.mode === "status") {
      return;
    }
    this.focus = "query";
    this.emit();
  }

  canStartSlashQuery(): boolean {
    return (
      this.mode === "cross-search" || this.mode === "pr-search" || this.mode === "issue-search"
    );
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
    await this.submitQuery(this.query);
    this.focus = "results";
    this.emit();
  }

  moveSelection(delta: number): void {
    if (this.focus === "nav") {
      const currentIndex = TUI_MODE_ORDER.findIndex((mode) => mode.id === this.mode);
      const nextIndex = Math.max(0, Math.min(TUI_MODE_ORDER.length - 1, currentIndex + delta));
      this.activateMode(TUI_MODE_ORDER[nextIndex]!.id);
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

  async submitQuery(value: string): Promise<void> {
    this.query = value.trim();
    this.errorMessage = null;
    this.isLandingView = false;
    this.showDetail = false;
    this.detailStatus = null;
    this.activeUrl = null;
    const requestId = ++this.listRequestId;
    switch (this.mode) {
      case "cross-search":
        await this.runBusy("Searching cross desk", async () => {
          const [pullRequests, issues] = await Promise.all([
            this.query ? this.service.search(this.query, CROSS_SEARCH_LIMITS.pr) : [],
            this.query ? this.service.searchIssues(this.query, CROSS_SEARCH_LIMITS.issue) : [],
          ]);
          const seedPr = pullRequests[0]?.prNumber ?? null;
          const cluster =
            seedPr !== null
              ? await this.service.clusterPr(seedPr, CROSS_SEARCH_LIMITS.cluster)
              : null;
          if (requestId !== this.listRequestId || this.mode !== "cross-search") {
            return;
          }
          this.rows = [
            ...pullRequests.map((pr) => this.toPrRow(pr)),
            ...issues.map((issue) => this.toIssueRow(issue)),
            ...this.clusterRowsFromAnalysis(cluster),
          ];
          this.selectedIndex = 0;
          this.resultTitle = `Cross Search${this.query ? ` · ${this.query}` : ""}`;
          this.context = null;
          this.clusterContext = cluster
            ? {
                analysis: cluster,
                seedLabel: `seed_pr: #${cluster.seedPr.prNumber} ${cluster.seedPr.title}`,
                verificationSummary: this.clusterVerification.get(cluster.seedPr.prNumber) ?? null,
              }
            : null;
          this.detailTitle = "Investigation Summary";
          this.detailText = this.isLandingView
            ? formatCrossSearchLandingDetail(this.statusSnapshot)
            : this.buildCrossSearchSummary(pullRequests, issues, cluster);
          this.message =
            this.rows.length > 0
              ? `Loaded ${this.rows.length} cross-search row(s).`
              : "No cross-search results.";
          this.activeUrl = this.rowUrl(this.rows[0]);
          this.emit();
        });
        return;
      case "pr-search":
        await this.runBusy("Searching PRs", async () => {
          const results = this.query ? await this.service.search(this.query, this.resultLimit) : [];
          if (requestId !== this.listRequestId || this.mode !== "pr-search") {
            return;
          }
          this.rows = results.map((pr) => this.toPrRow(pr));
          this.selectedIndex = 0;
          this.resultTitle = `PR Search${this.query ? ` · ${this.query}` : ""}`;
          this.detailTitle = "PR Desk";
          this.detailText =
            results.length > 0
              ? "Press Enter to open the selected PR detail."
              : formatSearchLandingDetail("pr-search", this.statusSnapshot);
          this.context = null;
          this.message =
            results.length > 0 ? `Loaded ${results.length} PR result(s).` : "No PR results.";
          this.activeUrl = this.rowUrl(this.rows[0]);
          this.emit();
        });
        return;
      case "issue-search":
        await this.runBusy("Searching issues", async () => {
          const results = this.query
            ? await this.service.searchIssues(this.query, this.resultLimit)
            : [];
          if (requestId !== this.listRequestId || this.mode !== "issue-search") {
            return;
          }
          this.rows = results.map((issue) => this.toIssueRow(issue));
          this.selectedIndex = 0;
          this.resultTitle = `Issue Search${this.query ? ` · ${this.query}` : ""}`;
          this.detailTitle = "Issue Desk";
          this.detailText =
            results.length > 0
              ? "Press Enter to open the selected issue detail."
              : formatSearchLandingDetail("issue-search", this.statusSnapshot);
          this.context = null;
          this.message =
            results.length > 0 ? `Loaded ${results.length} issue result(s).` : "No issue results.";
          this.activeUrl = this.rowUrl(this.rows[0]);
          this.emit();
        });
        return;
      case "pr-xref":
        await this.openPrXref(this.parseNumericQuery("PR Xref"));
        return;
      case "issue-xref":
        await this.openIssueXref(this.parseNumericQuery("Issue Xref"));
        return;
      case "cluster":
        await this.openCluster(this.parseNumericQuery("Cluster"));
        return;
      case "status":
        return;
      default:
        return;
    }
  }

  async openSelected(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row) {
      return;
    }
    if (this.showDetail) {
      this.showDetail = false;
      this.detailStatus = null;
      this.message = "Closed detail drawer.";
      this.emit();
      return;
    }
    this.showDetail = true;
    this.isLandingView = false;
    await this.refreshDetailForSelection(true);
    if (row.kind === "pr" || row.kind === "issue") {
      void this.autoRefreshDetail(row);
    }
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
      case "xref":
        await this.crossReferenceSelected();
        return;
      case "cluster":
        await this.clusterSelected();
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
      case "open-url":
        return;
      case "back":
        this.goBack();
        return;
      default:
        return;
    }
  }

  async crossReferenceSelected(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row) {
      return;
    }
    if (row.kind === "pr") {
      await this.openPrXref(row.pr.prNumber, true);
      return;
    }
    if (row.kind === "issue") {
      await this.openIssueXref(row.issue.issueNumber, true);
    }
  }

  async clusterSelected(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row) {
      return;
    }
    if (row.kind === "pr") {
      await this.openCluster(row.pr.prNumber, true);
      return;
    }
    if (row.kind === "cluster-candidate" || row.kind === "cluster-excluded") {
      await this.openCluster(row.candidate.prNumber, true);
    }
  }

  async syncPrs(): Promise<void> {
    await this.runBusy("Syncing PR metadata", async () => {
      this.syncMode = "metadata";
      const summary = await this.service.syncPrs();
      await this.refreshStatus();
      await this.replayActiveView();
      this.message = `Synced PR metadata: processed ${summary.processedPrs}, skipped ${summary.skippedPrs}.`;
    });
    this.syncMode = null;
    this.emit();
  }

  async syncIssues(): Promise<void> {
    await this.runBusy("Syncing issue metadata", async () => {
      this.syncMode = "metadata";
      const summary = await this.service.syncIssues();
      await this.refreshStatus();
      await this.replayActiveView();
      this.message = `Synced issue metadata: processed ${summary.processedIssues}, skipped ${summary.skippedIssues}.`;
    });
    this.syncMode = null;
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
    this.showDetail = snapshot.showDetail;
    this.activeUrl = snapshot.activeUrl;
    this.detailTitle = snapshot.detailTitle;
    this.resultTitle = snapshot.resultTitle;
    this.context = snapshot.context;
    this.clusterContext = null;
    this.isLandingView = snapshot.isLandingView;
    this.errorMessage = null;
    this.message = "Returned to previous view.";
    this.emit();
  }

  getActiveUrl(): string | null {
    return this.activeUrl ?? this.rowUrl(this.rows[this.selectedIndex]);
  }

  private buildActions(): TuiAction[] {
    const row = this.rows[this.selectedIndex];
    const hasRow = Boolean(row);
    const hasHistory = this.history.length > 0;
    const canXref = row?.kind === "pr" || row?.kind === "issue";
    const canCluster =
      row?.kind === "pr" || row?.kind === "cluster-candidate" || row?.kind === "cluster-excluded";
    const canRefresh =
      row?.kind === "pr" ||
      row?.kind === "issue" ||
      row?.kind === "cluster-candidate" ||
      row?.kind === "cluster-excluded" ||
      this.mode === "cluster";

    switch (this.mode) {
      case "cross-search":
        return [
          this.action(1, "query", "Search", "/"),
          this.action(2, "detail", this.showDetail ? "Close" : "Detail", "Enter", hasRow),
          this.action(3, "xref", "Xref", "x", canXref),
          this.action(4, "cluster", "Cluster", "c", canCluster),
          this.action(5, "sync-prs", "Sync PRs", "s"),
          this.action(6, "sync-issues", "Sync Issues", "S"),
          this.action(7, "refresh", "Refresh", "r", canRefresh),
        ];
      case "pr-search":
        return [
          this.action(1, "query", "Search", "/"),
          this.action(2, "detail", this.showDetail ? "Close" : "Detail", "Enter", hasRow),
          this.action(3, "xref", "Xref", "x", canXref),
          this.action(4, "cluster", "Cluster", "c", canCluster),
          this.action(5, "sync-prs", "Sync PRs", "s"),
          this.action(6, "refresh", "Refresh", "r", canRefresh),
        ];
      case "issue-search":
        return [
          this.action(1, "query", "Search", "/"),
          this.action(2, "detail", this.showDetail ? "Close" : "Detail", "Enter", hasRow),
          this.action(3, "xref", "Xref", "x", canXref),
          this.action(4, "sync-issues", "Sync Issues", "S"),
          this.action(5, "refresh", "Refresh", "r", canRefresh),
        ];
      case "pr-xref":
      case "issue-xref":
      case "cluster":
        return [
          this.action(1, "query", "Search", "1"),
          this.action(2, "detail", this.showDetail ? "Close" : "Detail", "Enter", hasRow),
          this.action(3, "refresh", "Refresh", "r", canRefresh),
          this.action(4, "back", "Back", "b", hasHistory),
          this.action(5, "sync-prs", "Sync PRs", "s"),
          this.action(6, "sync-issues", "Sync Issues", "S"),
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
    const rows = this.rows;
    const count = rows.length;
    if (this.mode === "status") {
      return { yieldLabel: `${count} metrics`, confidenceLabel: null, coverageLabel: null };
    }

    const prRows = rows.filter(
      (row): row is Extract<TuiResultRow, { kind: "pr" }> => row.kind === "pr",
    );
    const issueRows = rows.filter(
      (row): row is Extract<TuiResultRow, { kind: "issue" }> => row.kind === "issue",
    );
    const clusterRows = rows.filter(
      (
        row,
      ): row is
        | Extract<TuiResultRow, { kind: "cluster-candidate" }>
        | Extract<TuiResultRow, { kind: "cluster-excluded" }> =>
        row.kind === "cluster-candidate" || row.kind === "cluster-excluded",
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
      const seed = this.clusterContext?.analysis.seedPr.prNumber;
      const verification = seed ? this.clusterVerification.get(seed) : null;
      return {
        yieldLabel: `${count} hits`,
        confidenceLabel:
          scores.length > 0
            ? `PR ${prRows.length} · Issue ${issueRows.length} · Cluster ${clusterRows.length}`
            : `PR ${prRows.length} · Issue ${issueRows.length} · Cluster ${clusterRows.length}`,
        coverageLabel:
          verification && seed
            ? `seed #${seed} · ${this.verificationSummaryLabel(verification)}`
            : seed
              ? `seed #${seed} · cached`
              : null,
      };
    }
    if (this.mode === "pr-search" || this.mode === "issue-search") {
      return {
        yieldLabel: `${count} hits${count >= this.resultLimit ? ` · top ${this.resultLimit} shown` : ""}`,
        confidenceLabel,
        coverageLabel: null,
      };
    }
    if (this.mode === "pr-xref") {
      return {
        yieldLabel: `${count} related issue${count === 1 ? "" : "s"}`,
        confidenceLabel: null,
        coverageLabel: this.context?.kind === "pr" ? `source PR #${this.context.prNumber}` : null,
      };
    }
    if (this.mode === "issue-xref") {
      return {
        yieldLabel: `${count} related PR${count === 1 ? "" : "s"}`,
        confidenceLabel: null,
        coverageLabel:
          this.context?.kind === "issue" ? `source issue #${this.context.issueNumber}` : null,
      };
    }
    if (this.mode === "cluster") {
      const verification =
        this.context?.kind === "cluster"
          ? (this.clusterVerification.get(this.context.prNumber) ?? null)
          : null;
      return {
        yieldLabel: `${count} cluster rows`,
        confidenceLabel: null,
        coverageLabel: verification ? this.verificationSummaryLabel(verification) : "cached",
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

  private parseNumericQuery(label: string): number {
    const match = this.query.match(/\d+/);
    if (!match) {
      throw new Error(`${label} requires a numeric identifier.`);
    }
    return Number(match[0]);
  }

  private pushHistory(): void {
    this.history.push({
      mode: this.mode,
      query: this.query,
      rows: this.rows,
      selectedIndex: this.selectedIndex,
      detailText: this.detailText,
      detailStatus: this.detailStatus,
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
    if (this.mode === "status") {
      this.rows = buildStatusRows(this.statusSnapshot);
      this.detailText = formatStatusDetail(this.statusSnapshot);
      this.detailTitle = "Repository Status";
    }
  }

  async refreshSelected(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    const clusterRow =
      row && (row.kind === "cluster-candidate" || row.kind === "cluster-excluded") ? row : null;
    if (clusterRow || this.mode === "cluster") {
      const seedPrNumber =
        this.context?.kind === "cluster" ? this.context.prNumber : clusterRow?.candidate.prNumber;
      if (seedPrNumber === undefined) {
        return;
      }
      await this.verifyCluster(seedPrNumber);
      return;
    }
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

  private async openPrXref(prNumber: number, pushHistory = false): Promise<void> {
    await this.runBusy(`Cross-referencing PR #${prNumber}`, async () => {
      if (pushHistory) {
        this.pushHistory();
      }
      this.showDetail = false;
      this.detailStatus = null;
      const result = await this.service.xrefPr(prNumber, this.resultLimit);
      this.mode = "pr-xref";
      this.query = String(prNumber);
      this.rows = result.issues.map((issue) => this.toIssueRow(issue));
      this.selectedIndex = 0;
      this.resultTitle = `PR Xref · #${prNumber}`;
      this.detailTitle = "PR Cross Reference";
      this.context = { kind: "pr", prNumber };
      this.clusterContext = null;
      this.detailText = result.pullRequest
        ? `PR #${result.pullRequest.prNumber} ${result.pullRequest.title}\n\nPress Enter to inspect a related issue.`
        : `PR #${prNumber} not found in local cache.`;
      this.message =
        result.issues.length > 0
          ? `Loaded ${result.issues.length} related issue(s).`
          : "No related issues found.";
      this.activeUrl = result.pullRequest?.url ?? this.rowUrl(this.rows[0]);
      this.emit();
    });
  }

  private async openIssueXref(issueNumber: number, pushHistory = false): Promise<void> {
    await this.runBusy(`Cross-referencing issue #${issueNumber}`, async () => {
      if (pushHistory) {
        this.pushHistory();
      }
      this.showDetail = false;
      this.detailStatus = null;
      const result = await this.service.xrefIssue(issueNumber, this.resultLimit);
      this.mode = "issue-xref";
      this.query = String(issueNumber);
      this.rows = result.pullRequests.map((pr) => this.toPrRow(pr));
      this.selectedIndex = 0;
      this.resultTitle = `Issue Xref · #${issueNumber}`;
      this.detailTitle = "Issue Cross Reference";
      this.context = { kind: "issue", issueNumber };
      this.clusterContext = null;
      this.detailText = result.issue
        ? `Issue #${result.issue.issueNumber} ${result.issue.title}\n\nPress Enter to inspect a related PR.`
        : `Issue #${issueNumber} not found in local cache.`;
      this.message =
        result.pullRequests.length > 0
          ? `Loaded ${result.pullRequests.length} related PR(s).`
          : "No related PRs found.";
      this.activeUrl = result.issue?.url ?? this.rowUrl(this.rows[0]);
      this.emit();
    });
  }

  private async openCluster(prNumber: number, pushHistory = false): Promise<void> {
    await this.runBusy(`Loading cluster for PR #${prNumber}`, async () => {
      if (pushHistory) {
        this.pushHistory();
      }
      this.showDetail = false;
      this.detailStatus = null;
      const result = await this.service.clusterPr(prNumber, this.resultLimit);
      this.mode = "cluster";
      this.query = String(prNumber);
      this.context = { kind: "cluster", prNumber };
      if (!result) {
        this.rows = [];
        this.selectedIndex = 0;
        this.resultTitle = `Cluster · PR #${prNumber}`;
        this.detailTitle = "Cluster";
        this.detailText = `PR #${prNumber} not found in local cache.`;
        this.clusterContext = null;
        this.activeUrl = null;
        this.message = `PR #${prNumber} not found.`;
        this.emit();
        return;
      }
      this.clusterContext = {
        analysis: result,
        seedLabel: `seed_pr: #${result.seedPr.prNumber} ${result.seedPr.title}`,
        verificationSummary: this.clusterVerification.get(prNumber) ?? null,
      };
      this.rows = this.clusterRowsFromAnalysis(result);
      this.selectedIndex = 0;
      this.resultTitle = `Cluster · PR #${prNumber}`;
      this.detailTitle = "Cluster";
      this.detailText = formatClusterLandingDetail(
        prNumber,
        this.clusterContext.verificationSummary
          ? this.verificationSummaryLabel(this.clusterContext.verificationSummary)
          : null,
      );
      this.activeUrl = result.seedPr.url;
      this.message =
        this.rows.length > 0
          ? `Loaded ${this.rows.length} cluster row(s).`
          : "No cluster rows found.";
      this.emit();
    });
  }

  private async loadLandingRows(
    mode: "cross-search" | "pr-search" | "issue-search",
  ): Promise<void> {
    const requestId = ++this.listRequestId;
    this.isLandingView = true;
    this.showDetail = false;
    this.detailStatus = null;
    this.emit();
    try {
      if (mode === "cross-search") {
        const [pullRequests, issues] = await Promise.all([
          this.service.search("state:open", CROSS_SEARCH_LIMITS.pr),
          this.service.searchIssues("state:open", CROSS_SEARCH_LIMITS.issue),
        ]);
        if (requestId !== this.listRequestId || this.mode !== "cross-search") {
          return;
        }
        this.rows = [
          ...pullRequests.map((pr) => this.toPrRow(pr)),
          ...issues.map((issue) => this.toIssueRow(issue)),
        ];
        this.selectedIndex = 0;
        this.resultTitle = "Cross Search";
        this.detailTitle = "Start Here";
        this.detailText = formatCrossSearchLandingDetail(this.statusSnapshot);
        this.message =
          this.rows.length > 0
            ? `Loaded ${this.rows.length} cached investigation rows. Press / to refine.`
            : "No cached rows found.";
        this.activeUrl = this.rowUrl(this.rows[0]);
        this.emit();
        return;
      }
      if (mode === "pr-search") {
        const results = await this.service.search("state:open", this.resultLimit);
        if (requestId !== this.listRequestId || this.mode !== "pr-search") {
          return;
        }
        this.rows = results.map((pr) => this.toPrRow(pr));
        this.selectedIndex = 0;
        this.resultTitle = "Recent Open PRs";
        this.detailTitle = "Start Here";
        this.detailText = formatSearchLandingDetail("pr-search", this.statusSnapshot);
        this.message =
          results.length > 0 ? `Loaded ${results.length} recent open PR(s).` : "No open PRs found.";
        this.activeUrl = this.rowUrl(this.rows[0]);
        this.emit();
        return;
      }
      const issues = await this.service.searchIssues("state:open", this.resultLimit);
      if (requestId !== this.listRequestId || this.mode !== "issue-search") {
        return;
      }
      this.rows = issues.map((issue) => this.toIssueRow(issue));
      this.selectedIndex = 0;
      this.resultTitle = "Recent Open Issues";
      this.detailTitle = "Start Here";
      this.detailText = formatSearchLandingDetail("issue-search", this.statusSnapshot);
      this.message =
        issues.length > 0
          ? `Loaded ${issues.length} recent open issue(s).`
          : "No open issues found.";
      this.activeUrl = this.rowUrl(this.rows[0]);
      this.emit();
    } catch (error) {
      if (requestId !== this.listRequestId) {
        return;
      }
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.message = "Failed to load landing rows.";
      this.emit();
    }
  }

  private async replayActiveView(): Promise<void> {
    if (this.mode === "cross-search" || this.mode === "pr-search" || this.mode === "issue-search") {
      if (this.query) {
        await this.submitQuery(this.query);
      } else {
        await this.loadLandingRows(this.mode);
      }
      return;
    }
    if (this.mode === "pr-xref" && this.context?.kind === "pr") {
      await this.openPrXref(this.context.prNumber, false);
      return;
    }
    if (this.mode === "issue-xref" && this.context?.kind === "issue") {
      await this.openIssueXref(this.context.issueNumber, false);
      return;
    }
    if (this.mode === "cluster" && this.context?.kind === "cluster") {
      await this.openCluster(this.context.prNumber, false);
      return;
    }
    if (this.mode === "status" && this.statusSnapshot) {
      this.rows = buildStatusRows(this.statusSnapshot);
      this.detailText = formatStatusDetail(this.statusSnapshot);
      this.emit();
    }
  }

  private async refreshDetailForSelection(force = false): Promise<void> {
    if (!this.showDetail && !force) {
      this.emit();
      return;
    }
    const row = this.rows[this.selectedIndex];
    if (!row) {
      if (this.mode === "cross-search") {
        this.detailTitle = "Start Here";
        this.detailText = formatCrossSearchLandingDetail(this.statusSnapshot);
      } else if (this.mode === "pr-search" || this.mode === "issue-search") {
        this.detailTitle = "Start Here";
        this.detailText = formatSearchLandingDetail(this.mode, this.statusSnapshot);
      } else if (this.mode === "status" && this.statusSnapshot) {
        this.detailTitle = "Repository Status";
        this.detailText = formatStatusDetail(this.statusSnapshot);
      }
      this.emit();
      return;
    }
    const requestId = ++this.detailRequestId;
    if (row.kind === "pr") {
      const payload = await this.service.show(row.pr.prNumber);
      if (requestId !== this.detailRequestId || !payload.pr) {
        return;
      }
      this.detailTitle = `PR #${payload.pr.prNumber}`;
      this.detailText = formatPrDetail(payload.pr, payload.comments);
      this.detailStatus =
        this.detailAutoRefreshInFlight &&
        this.detailRefreshTarget?.kind === "pr" &&
        this.detailRefreshTarget.id === payload.pr.prNumber
          ? "Refreshing detail..."
          : `Freshness: ${this.rowFreshness(row).toUpperCase()}`;
      this.activeUrl = payload.pr.url;
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
      this.detailStatus =
        this.detailAutoRefreshInFlight &&
        this.detailRefreshTarget?.kind === "issue" &&
        this.detailRefreshTarget.id === issue.issueNumber
          ? "Refreshing detail..."
          : `Freshness: ${this.rowFreshness(row).toUpperCase()}`;
      this.activeUrl = issue.url;
      this.emit();
      return;
    }
    if (
      (row.kind === "cluster-candidate" || row.kind === "cluster-excluded") &&
      this.clusterContext
    ) {
      this.detailTitle = `Cluster #${row.candidate.prNumber}`;
      this.detailText = formatClusterDetail(
        {
          seedLabel: this.clusterContext.seedLabel,
          clusterBasis: this.clusterContext.analysis.clusterBasis,
          clusterIssues: this.clusterContext.analysis.clusterIssueNumbers,
          verificationSummary: this.clusterContext.verificationSummary
            ? this.verificationSummaryLabel(this.clusterContext.verificationSummary)
            : "cached only",
          mergeSummary: this.clusterContext.analysis.mergeReadiness
            ? `${this.clusterContext.analysis.mergeReadiness.state} via ${this.clusterContext.analysis.mergeReadiness.source}`
            : null,
        },
        row.candidate,
      );
      this.detailStatus = `Verification: ${this.clusterRowVerification(row).replace(/_/g, "-")}`;
      this.activeUrl = row.candidate.url;
      this.emit();
      return;
    }
    if (row.kind === "status" && this.statusSnapshot) {
      this.detailTitle = "Repository Status";
      this.detailText = formatStatusDetail(this.statusSnapshot);
      this.detailStatus = null;
      this.activeUrl = null;
      this.emit();
    }
  }

  private async autoRefreshDetail(
    row: Extract<TuiResultRow, { kind: "pr" | "issue" }>,
  ): Promise<void> {
    if (this.detailAutoRefreshInFlight) {
      return;
    }
    const target: DetailRefreshTarget =
      row.kind === "pr"
        ? { kind: "pr", id: row.pr.prNumber }
        : { kind: "issue", id: row.issue.issueNumber };
    this.detailAutoRefreshInFlight = true;
    this.detailRefreshTarget = target;
    this.syncMode = "detail";
    this.detailStatus = "Refreshing detail...";
    this.emit();
    try {
      if (row.kind === "pr") {
        await this.service.refreshPrDetail(row.pr.prNumber);
        this.detailFreshness.set(this.rowIdentity(row), "fresh");
      } else {
        await this.service.refreshIssueDetail(row.issue.issueNumber);
        this.detailFreshness.set(this.rowIdentity(row), "fresh");
      }
      await this.refreshStatus();
      if (this.showDetail && this.matchesDetailTarget(target)) {
        await this.refreshDetailForSelection(true);
      }
      this.message = `${row.kind === "pr" ? "PR" : "Issue"} detail refreshed from GitHub.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/rate limit/i.test(message)) {
        this.message = "Detail refresh rate-limited. Showing cached detail.";
      } else {
        this.message = `Detail refresh failed: ${message}`;
      }
      this.errorMessage = null;
    } finally {
      this.detailAutoRefreshInFlight = false;
      this.detailRefreshTarget = null;
      this.syncMode = null;
      if (this.showDetail && this.matchesDetailTarget(target)) {
        await this.refreshDetailForSelection(true);
      } else {
        this.emit();
      }
    }
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

  private async verifyCluster(prNumber: number): Promise<void> {
    this.clusterVerification.set(prNumber, {
      verifiedPrCount: 0,
      verifiedIssueCount: 0,
      missingCount: 0,
      state: "running",
    });
    this.syncMode = "cluster_verify";
    this.detailStatus = "Verifying cluster...";
    this.emit();
    try {
      const result = await this.service.verifyClusterPr(prNumber, this.resultLimit);
      this.clusterVerification.set(prNumber, result.summary);
      if (
        this.mode === "cluster" &&
        this.context?.kind === "cluster" &&
        this.context.prNumber === prNumber
      ) {
        if (result.analysis) {
          this.clusterContext = {
            analysis: result.analysis,
            seedLabel: `seed_pr: #${result.analysis.seedPr.prNumber} ${result.analysis.seedPr.title}`,
            verificationSummary: result.summary,
          };
          this.rows = this.clusterRowsFromAnalysis(result.analysis);
          this.activeUrl = result.analysis.seedPr.url;
        }
        if (this.showDetail) {
          await this.refreshDetailForSelection(true);
        } else {
          this.detailText = formatClusterLandingDetail(
            prNumber,
            this.verificationSummaryLabel(result.summary),
          );
        }
      } else if (this.mode === "cross-search" && this.query) {
        await this.submitQuery(this.query);
      }
      this.message =
        result.summary.state === "rate_limited"
          ? `Cluster verification hit rate limit after ${result.summary.verifiedPrCount} PR(s) and ${result.summary.verifiedIssueCount} issue(s).`
          : `Verified cluster: ${result.summary.verifiedPrCount} PR(s), ${result.summary.verifiedIssueCount} issue(s).`;
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.syncMode = null;
      this.detailStatus = null;
      await this.refreshStatus();
      this.emit();
    }
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

  private toPrRow(pr: SearchResult): Extract<TuiResultRow, { kind: "pr" }> {
    return { kind: "pr", pr, freshness: this.prFreshness(pr.updatedAt, `pr:${pr.prNumber}`) };
  }

  private toIssueRow(issue: IssueSearchResult): Extract<TuiResultRow, { kind: "issue" }> {
    return {
      kind: "issue",
      issue,
      freshness: this.prFreshness(issue.updatedAt, `issue:${issue.issueNumber}`),
    };
  }

  private clusterRowsFromAnalysis(
    analysis: ClusterPullRequestAnalysis | null,
  ): Array<
    | Extract<TuiResultRow, { kind: "cluster-candidate" }>
    | Extract<TuiResultRow, { kind: "cluster-excluded" }>
  > {
    if (!analysis) {
      return [];
    }
    const verification = this.clusterVerification.get(analysis.seedPr.prNumber)?.state ?? "idle";
    return [
      ...analysis.sameClusterCandidates.map((candidate) => ({
        kind: "cluster-candidate" as const,
        candidate,
        verification,
      })),
      ...analysis.nearbyButExcluded.map((candidate) => ({
        kind: "cluster-excluded" as const,
        candidate,
        verification,
      })),
    ];
  }

  private buildCrossSearchSummary(
    pullRequests: SearchResult[],
    issues: IssueSearchResult[],
    cluster: ClusterPullRequestAnalysis | null,
  ): string {
    const lines = [
      "Cross Search merges cached PRs, issues, and cluster signals into one table.",
      "",
      `PR hits: ${pullRequests.length}`,
      `Issue hits: ${issues.length}`,
      `Cluster rows: ${
        (cluster?.sameClusterCandidates.length ?? 0) + (cluster?.nearbyButExcluded.length ?? 0)
      }`,
    ];
    if (cluster) {
      lines.push(`Seed PR: #${cluster.seedPr.prNumber}`);
      lines.push(`Cluster basis: ${cluster.clusterBasis}`);
    }
    lines.push("", "Press Enter to inspect the selected row.");
    return lines.join("\n");
  }

  private prFreshness(updatedAt: string, key: string): TuiFreshness {
    const session = this.detailFreshness.get(key);
    if (session) {
      return session;
    }
    const ageMs = Date.now() - new Date(updatedAt).getTime();
    if (ageMs < 1000 * 60 * 60 * 12) {
      return "fresh";
    }
    if (ageMs > 1000 * 60 * 60 * 24 * 7) {
      return "stale";
    }
    return "partial";
  }

  private rowFreshness(row: Extract<TuiResultRow, { kind: "pr" | "issue" }>): TuiFreshness {
    return row.freshness;
  }

  private clusterRowVerification(
    row: Extract<TuiResultRow, { kind: "cluster-candidate" | "cluster-excluded" }>,
  ): TuiVerificationState {
    return row.verification;
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
    if (row.kind === "cluster-candidate" || row.kind === "cluster-excluded") {
      return row.candidate.url;
    }
    return null;
  }

  private matchesDetailTarget(target: DetailRefreshTarget): boolean {
    if (!target) {
      return false;
    }
    const row = this.rows[this.selectedIndex];
    if (!row) {
      return false;
    }
    return (
      (row.kind === "pr" && target.kind === "pr" && row.pr.prNumber === target.id) ||
      (row.kind === "issue" && target.kind === "issue" && row.issue.issueNumber === target.id)
    );
  }

  private verificationSummaryLabel(summary: TuiClusterVerificationSummary): string {
    return `${summary.state === "rate_limited" ? "rate-limited" : summary.state} · PR ${summary.verifiedPrCount} · issue ${summary.verifiedIssueCount} · missing ${summary.missingCount}`;
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
