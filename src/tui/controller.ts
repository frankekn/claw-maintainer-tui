import {
  buildStatusRows,
  defaultHintText,
  formatClusterDetail,
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
  TuiContext,
  TuiDataService,
  TuiFocus,
  TuiMode,
  TuiRenderModel,
  TuiResultRow,
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
};

export class TuiController {
  private readonly listeners = new Set<() => void>();
  private readonly resultLimit: number;
  private statusSnapshot: StatusSnapshot | null = null;
  private mode: TuiMode = "pr-search";
  private focus: TuiFocus = "results";
  private rows: TuiResultRow[] = [];
  private selectedIndex = 0;
  private detailText = "Use / to search PRs.";
  private detailTitle = "Detail";
  private resultTitle = "Results";
  private activeUrl: string | null = null;
  private query = "";
  private context: TuiContext = null;
  private busyMessage: string | null = null;
  private errorMessage: string | null = null;
  private message = "Ready.";
  private readonly history: TuiViewSnapshot[] = [];
  private detailRequestId = 0;
  private listRequestId = 0;
  private clusterContext: ClusterContextState | null = null;

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
        busyMessage: this.busyMessage,
        errorMessage: this.errorMessage,
      },
      footer: {
        hintText: defaultHintText(),
        message: this.errorMessage ?? this.message,
        queryPrompt: modeInfo.queryPrompt,
        queryValue: this.query,
      },
      mode: this.mode,
      focus: this.focus,
      rows: this.rows,
      selectedIndex: this.selectedIndex,
      detailText: this.detailText,
      activeUrl: this.activeUrl,
      query: this.query,
      resultTitle: this.resultTitle,
      detailTitle: this.detailTitle,
      context: this.context,
      queryPlaceholder: modeInfo.queryPrompt,
      busy: this.busyMessage !== null,
    };
  }

  async initialize(): Promise<void> {
    await this.refreshStatus();
    await this.loadLandingRows("pr-search");
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
      return;
    }
    this.mode = mode;
    this.rows = [];
    this.selectedIndex = 0;
    this.context = mode === "status" ? null : null;
    this.clusterContext = null;
    this.activeUrl = null;
    if (mode === "status" && this.statusSnapshot) {
      this.rows = buildStatusRows(this.statusSnapshot);
      this.resultTitle = "Status";
      this.detailTitle = "Repository Status";
      this.detailText = formatStatusDetail(this.statusSnapshot);
      this.query = "";
    } else {
      this.detailTitle = "Detail";
      this.detailText = `Use / to ${TUI_MODE_ORDER.find((item) => item.id === mode)?.queryPrompt.toLowerCase()}.`;
      this.resultTitle = TUI_MODE_ORDER.find((item) => item.id === mode)?.label ?? "Results";
      this.query = "";
    }
    this.emit();
    if (mode === "pr-search" || mode === "issue-search") {
      void this.loadLandingRows(mode);
    }
  }

  isQueryFocus(): boolean {
    return this.focus === "query";
  }

  startQueryEntry(): void {
    if (this.mode === "status") {
      return;
    }
    this.focus = "query";
    this.emit();
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
    this.emit();
    void this.refreshDetailForSelection();
  }

  async submitQuery(value: string): Promise<void> {
    this.query = value.trim();
    this.errorMessage = null;
    const requestId = ++this.listRequestId;
    switch (this.mode) {
      case "pr-search":
        await this.runBusy("Searching PRs", async () => {
          const results = this.query ? await this.service.search(this.query, this.resultLimit) : [];
          if (requestId !== this.listRequestId || this.mode !== "pr-search") {
            return;
          }
          this.rows = results.map((pr) => ({ kind: "pr", pr }));
          this.selectedIndex = 0;
          this.resultTitle = `PR Search${this.query ? ` · ${this.query}` : ""}`;
          this.detailTitle = "PR Detail";
          this.context = null;
          this.message =
            results.length > 0 ? `Loaded ${results.length} PR result(s).` : "No PR results.";
          await this.refreshDetailForSelection();
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
          this.rows = results.map((issue) => ({ kind: "issue", issue }));
          this.selectedIndex = 0;
          this.resultTitle = `Issue Search${this.query ? ` · ${this.query}` : ""}`;
          this.detailTitle = "Issue Detail";
          this.context = null;
          this.message =
            results.length > 0 ? `Loaded ${results.length} issue result(s).` : "No issue results.";
          await this.refreshDetailForSelection();
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
    await this.refreshDetailForSelection(true);
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
    if (row.kind === "cluster-candidate") {
      await this.openCluster(row.candidate.prNumber, true);
    }
  }

  async syncPrs(): Promise<void> {
    await this.runBusy("Syncing PRs", async () => {
      const summary = await this.service.syncPrs();
      await this.refreshStatus();
      this.message = `Synced PRs: processed ${summary.processedPrs}, skipped ${summary.skippedPrs}.`;
      await this.replayActiveView();
    });
  }

  async syncIssues(): Promise<void> {
    await this.runBusy("Syncing issues", async () => {
      const summary = await this.service.syncIssues();
      await this.refreshStatus();
      this.message = `Synced issues: processed ${summary.processedIssues}, skipped ${summary.skippedIssues}.`;
      await this.replayActiveView();
    });
  }

  async refreshFacts(): Promise<void> {
    const prNumber = this.currentPrNumber();
    if (!prNumber) {
      this.message = "No PR selected.";
      this.emit();
      return;
    }
    await this.runBusy(`Refreshing PR #${prNumber} facts`, async () => {
      await this.service.refreshPrFacts(prNumber);
      await this.refreshStatus();
      this.message = `Refreshed PR #${prNumber} facts.`;
      await this.replayActiveView();
    });
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
    this.activeUrl = snapshot.activeUrl;
    this.detailTitle = snapshot.detailTitle;
    this.resultTitle = snapshot.resultTitle;
    this.context = snapshot.context;
    this.clusterContext = null;
    this.errorMessage = null;
    this.message = "Returned to previous view.";
    this.emit();
  }

  getActiveUrl(): string | null {
    return this.activeUrl;
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
      activeUrl: this.activeUrl,
      detailTitle: this.detailTitle,
      resultTitle: this.resultTitle,
      context: this.context,
    });
  }

  private currentPrNumber(): number | null {
    const row = this.rows[this.selectedIndex];
    if (row?.kind === "pr") {
      return row.pr.prNumber;
    }
    if (row?.kind === "cluster-candidate") {
      return row.candidate.prNumber;
    }
    if (this.context?.kind === "pr") {
      return this.context.prNumber;
    }
    if (this.context?.kind === "cluster") {
      return this.context.prNumber;
    }
    return null;
  }

  private async openPrXref(prNumber: number, pushHistory = false): Promise<void> {
    await this.runBusy(`Cross-referencing PR #${prNumber}`, async () => {
      if (pushHistory) {
        this.pushHistory();
      }
      const result = await this.service.xrefPr(prNumber, this.resultLimit);
      this.mode = "pr-xref";
      this.query = String(prNumber);
      this.rows = result.issues.map((issue) => ({ kind: "issue", issue }));
      this.selectedIndex = 0;
      this.resultTitle = `Related Issues · PR #${prNumber}`;
      this.detailTitle = "PR Cross-Reference";
      this.context = { kind: "pr", prNumber };
      if (!result.pullRequest) {
        this.detailText = `PR #${prNumber} not found in local index.`;
        this.activeUrl = null;
      } else {
        this.activeUrl = result.pullRequest.url;
        this.detailText = `PR #${result.pullRequest.prNumber} ${result.pullRequest.title}\nurl: ${result.pullRequest.url}\n\nSelect a related issue for details.`;
      }
      this.message =
        result.issues.length > 0
          ? `Loaded ${result.issues.length} related issue(s).`
          : "No related issues found.";
      await this.refreshDetailForSelection();
    });
  }

  private async openIssueXref(issueNumber: number, pushHistory = false): Promise<void> {
    await this.runBusy(`Cross-referencing issue #${issueNumber}`, async () => {
      if (pushHistory) {
        this.pushHistory();
      }
      const result = await this.service.xrefIssue(issueNumber, this.resultLimit);
      this.mode = "issue-xref";
      this.query = String(issueNumber);
      this.rows = result.pullRequests.map((pr) => ({ kind: "pr", pr }));
      this.selectedIndex = 0;
      this.resultTitle = `Related PRs · Issue #${issueNumber}`;
      this.detailTitle = "Issue Cross-Reference";
      this.context = { kind: "issue", issueNumber };
      if (!result.issue) {
        this.detailText = `Issue #${issueNumber} not found in local index.`;
        this.activeUrl = null;
      } else {
        this.activeUrl = result.issue.url;
        this.detailText = `Issue #${result.issue.issueNumber} ${result.issue.title}\nurl: ${result.issue.url}\n\nSelect a related PR for details.`;
      }
      this.message =
        result.pullRequests.length > 0
          ? `Loaded ${result.pullRequests.length} related PR(s).`
          : "No related PRs found.";
      await this.refreshDetailForSelection();
    });
  }

  private async openCluster(prNumber: number, pushHistory = false): Promise<void> {
    await this.runBusy(`Clustering PR #${prNumber}`, async () => {
      if (pushHistory) {
        this.pushHistory();
      }
      const result = await this.service.clusterPr(prNumber, this.resultLimit);
      this.mode = "cluster";
      this.query = String(prNumber);
      this.context = { kind: "cluster", prNumber };
      if (!result) {
        this.rows = [];
        this.selectedIndex = 0;
        this.resultTitle = `Cluster · PR #${prNumber}`;
        this.detailTitle = "Cluster";
        this.detailText = `PR #${prNumber} not found in local index.`;
        this.activeUrl = null;
        this.clusterContext = null;
        this.message = `PR #${prNumber} not found.`;
        return;
      }
      this.rows = [
        ...result.sameClusterCandidates.map((candidate) => ({
          kind: "cluster-candidate" as const,
          candidate,
        })),
        ...result.nearbyButExcluded.map((candidate) => ({
          kind: "cluster-excluded" as const,
          candidate,
        })),
      ];
      this.selectedIndex = 0;
      this.resultTitle = `Cluster · PR #${prNumber}`;
      this.detailTitle = "Cluster Candidate";
      this.activeUrl = result.seedPr.url;
      this.clusterContext = {
        analysis: result,
        seedLabel: `seed_pr: #${result.seedPr.prNumber} ${result.seedPr.title}`,
      };
      this.message =
        this.rows.length > 0
          ? `Loaded ${this.rows.length} cluster row(s).`
          : "No cluster candidates found.";
      await this.refreshDetailForSelection();
    });
  }

  private async refreshStatus(): Promise<void> {
    this.statusSnapshot = await this.service.status();
    if (this.mode === "status") {
      this.rows = buildStatusRows(this.statusSnapshot);
      this.detailText = formatStatusDetail(this.statusSnapshot);
      this.detailTitle = "Repository Status";
    }
  }

  private async loadLandingRows(mode: "pr-search" | "issue-search"): Promise<void> {
    const requestId = ++this.listRequestId;
    this.message =
      mode === "pr-search" ? "Loading recent open PRs..." : "Loading recent open issues...";
    this.emit();
    try {
      if (mode === "pr-search") {
        const results = await this.service.search("state:open", this.resultLimit);
        if (requestId !== this.listRequestId || this.mode !== "pr-search") {
          return;
        }
        this.rows = results.map((pr) => ({ kind: "pr", pr }));
        this.selectedIndex = 0;
        this.resultTitle = "Recent Open PRs";
        this.detailTitle = "PR Detail";
        this.detailText = formatSearchLandingDetail("pr-search", this.statusSnapshot);
        this.message =
          results.length > 0
            ? `Loaded ${results.length} recent open PR(s). Press / to refine the list.`
            : "No open PRs found in the local index.";
        await this.refreshDetailForSelection();
        return;
      }
      const issues = await this.service.searchIssues("state:open", this.resultLimit);
      if (requestId !== this.listRequestId || this.mode !== "issue-search") {
        return;
      }
      this.rows = issues.map((issue) => ({ kind: "issue", issue }));
      this.selectedIndex = 0;
      this.resultTitle = "Recent Open Issues";
      this.detailTitle = "Issue Detail";
      this.detailText = formatSearchLandingDetail("issue-search", this.statusSnapshot);
      this.message =
        issues.length > 0
          ? `Loaded ${issues.length} recent open issue(s). Press / to refine the list.`
          : "No open issues found in the local index.";
      await this.refreshDetailForSelection();
    } catch (error) {
      if (requestId !== this.listRequestId || this.mode !== mode) {
        return;
      }
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.message = "Failed to load landing rows.";
      this.emit();
    }
  }

  private async replayActiveView(): Promise<void> {
    if (this.mode === "pr-search" || this.mode === "issue-search") {
      if (this.query) {
        await this.submitQuery(this.query);
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
    const row = this.rows[this.selectedIndex];
    if (!row) {
      if (this.mode === "status" && this.statusSnapshot) {
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
      this.detailTitle = force ? `PR #${payload.pr.prNumber}` : "PR Detail";
      this.detailText = formatPrDetail(payload.pr, payload.comments);
      this.activeUrl = payload.pr.url;
      this.emit();
      return;
    }
    if (row.kind === "issue") {
      const issue = await this.service.showIssue(row.issue.issueNumber);
      if (requestId !== this.detailRequestId || !issue) {
        return;
      }
      this.detailTitle = force ? `Issue #${issue.issueNumber}` : "Issue Detail";
      this.detailText = formatIssueDetail(issue);
      this.activeUrl = issue.url;
      this.emit();
      return;
    }
    if (
      (row.kind === "cluster-candidate" || row.kind === "cluster-excluded") &&
      this.clusterContext
    ) {
      this.detailTitle =
        row.kind === "cluster-candidate"
          ? `Cluster Candidate #${row.candidate.prNumber}`
          : `Excluded #${row.candidate.prNumber}`;
      this.detailText = formatClusterDetail(
        {
          seedLabel: this.clusterContext.seedLabel,
          clusterBasis: this.clusterContext.analysis.clusterBasis,
          clusterIssues: this.clusterContext.analysis.clusterIssueNumbers,
          mergeSummary: this.clusterContext.analysis.mergeReadiness
            ? `${this.clusterContext.analysis.mergeReadiness.state} via ${this.clusterContext.analysis.mergeReadiness.source}`
            : null,
        },
        row.candidate,
      );
      this.activeUrl = row.candidate.url;
      this.emit();
      return;
    }
    if (row.kind === "status" && this.statusSnapshot) {
      this.detailTitle = "Repository Status";
      this.detailText = formatStatusDetail(this.statusSnapshot);
      this.activeUrl = null;
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

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
