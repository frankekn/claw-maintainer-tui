import { GhCliPullRequestDataSource } from "../github.js";
import { PrIndexStore } from "../store.js";
import { selectSyncDecision } from "../sync-planner.js";
import type { PlannerEntity, PlannerSnapshot } from "../sync-planner.js";
import type { AttentionState, RepoRef, StatusSnapshot, SyncSummary } from "../types.js";
import type {
  TuiClusterVerificationSummary,
  TuiDataService,
  TuiVerificationState,
} from "./types.js";
import type { SyncProgressEvent } from "../types.js";

export class StoreBackedTuiDataService implements TuiDataService {
  private rateLimitCache: {
    value: Awaited<ReturnType<GhCliPullRequestDataSource["getRateLimitStatus"]>>;
    expiresAt: number;
  } | null = null;

  constructor(
    private readonly store: PrIndexStore,
    private readonly source: GhCliPullRequestDataSource,
    private readonly repo: RepoRef,
  ) {}

  status() {
    return this.store.status();
  }

  listPriorityInbox(options: { limit: number; scanLimit?: number }) {
    return this.store.listPriorityInbox({
      repo: this.repo,
      limit: options.limit,
      scanLimit: options.scanLimit,
    });
  }

  listPriorityQueue(options: { limit: number; scanLimit?: number }) {
    return this.store.listPriorityQueue({
      repo: this.repo,
      limit: options.limit,
      scanLimit: options.scanLimit,
    });
  }

  listWatchlist(limit: number) {
    return this.store.listWatchlist(this.repo, limit);
  }

  search(query: string, limit: number) {
    return this.store.search(query, limit);
  }

  searchIssues(query: string, limit: number) {
    return this.store.searchIssues(query, limit);
  }

  getPrContextBundle(prNumber: number) {
    return this.store.getPrContextBundle(this.repo, prNumber);
  }

  show(prNumber: number) {
    return this.store.show(prNumber);
  }

  showIssue(issueNumber: number) {
    return this.store.showIssue(issueNumber);
  }

  xrefIssue(issueNumber: number, limit: number) {
    return this.store.crossReferenceIssueToPullRequests(issueNumber, limit);
  }

  xrefPr(prNumber: number, limit: number) {
    return this.store.crossReferencePullRequestToIssues(prNumber, limit);
  }

  clusterPr(prNumber: number, limit: number) {
    return this.store.clusterPullRequest({
      prNumber,
      limit,
      ftsOnly: true,
      repo: this.repo,
      source: this.source,
    });
  }

  async verifyClusterPr(prNumber: number, limit: number) {
    const initial =
      (await this.store.clusterPullRequest({
        prNumber,
        limit,
        ftsOnly: true,
      })) ?? null;
    if (!initial) {
      return {
        analysis: null,
        summary: {
          verifiedPrCount: 0,
          verifiedIssueCount: 0,
          missingCount: 0,
          state: "idle" as const,
        },
      };
    }

    let verifiedPrCount = 0;
    let verifiedIssueCount = 0;
    let missingCount = 0;
    let state: TuiVerificationState = "running";

    const prNumbers = new Set<number>([
      prNumber,
      ...initial.sameClusterCandidates
        .slice(0, Math.min(limit, 4))
        .map((candidate) => candidate.prNumber),
    ]);
    const issueNumbers = new Set<number>(initial.clusterIssueNumbers);
    for (const candidate of initial.sameClusterCandidates.slice(0, Math.min(limit, 4))) {
      for (const issueNumber of candidate.linkedIssues) {
        issueNumbers.add(issueNumber);
      }
    }

    for (const targetPrNumber of prNumbers) {
      try {
        await this.store.refreshPullRequestDetail(this.repo, this.source, targetPrNumber);
        verifiedPrCount += 1;
      } catch (error) {
        if (isRateLimitError(error)) {
          state = "rate_limited";
          break;
        }
        missingCount += 1;
      }
    }

    if (state !== "rate_limited") {
      for (const issueNumber of issueNumbers) {
        try {
          await this.store.refreshIssueDetail(this.repo, this.source, issueNumber);
          verifiedIssueCount += 1;
        } catch (error) {
          if (isRateLimitError(error)) {
            state = "rate_limited";
            break;
          }
          missingCount += 1;
        }
      }
    }

    const analysis =
      (await this.store.clusterPullRequest({
        prNumber,
        limit,
        ftsOnly: true,
      })) ?? initial;

    const summary: TuiClusterVerificationSummary = {
      verifiedPrCount,
      verifiedIssueCount,
      missingCount,
      state: state === "running" ? "done" : state,
    };

    return {
      analysis,
      summary,
    };
  }

  async syncPrs(options?: {
    onProgress?: (event: SyncProgressEvent) => void;
    trigger?: "manual" | "auto";
  }): Promise<SyncSummary> {
    if (isPlannerDisabled()) {
      return this.store.sync({
        repo: this.repo,
        source: this.source,
        full: false,
        hydrateAll: false,
        onProgress: options?.onProgress,
      });
    }
    const snapshot = await this.buildPlannerSnapshot("prs", options?.trigger ?? "manual");
    const decision = selectSyncDecision(snapshot);
    if (decision.kind === "skip") {
      return this.makeSkippedSummary("prs", decision.reason);
    }
    switch (decision.mode) {
      case "full":
        return this.store.sync({
          repo: this.repo,
          source: this.source,
          full: true,
          hydrateAll: false,
          onProgress: options?.onProgress,
        });
      case "incremental":
        return this.store.sync({
          repo: this.repo,
          source: this.source,
          full: false,
          hydrateAll: false,
          onProgress: options?.onProgress,
        });
      case "hot":
        return this.store.syncHotPullRequests({
          repo: this.repo,
          source: this.source,
          onProgress: options?.onProgress,
        });
      case "backfill":
        return this.store.runBackfillSlice({
          entity: "prs",
          repo: this.repo,
          source: this.source,
          onProgress: options?.onProgress,
        });
    }
  }

  async syncIssues(options?: {
    onProgress?: (event: SyncProgressEvent) => void;
    trigger?: "manual" | "auto";
  }): Promise<SyncSummary> {
    if (isPlannerDisabled()) {
      return this.store.syncIssues({
        repo: this.repo,
        source: this.source,
        full: false,
        onProgress: options?.onProgress,
      });
    }
    const snapshot = await this.buildPlannerSnapshot("issues", options?.trigger ?? "manual");
    const decision = selectSyncDecision(snapshot);
    if (decision.kind === "skip") {
      return this.makeSkippedSummary("issues", decision.reason);
    }
    switch (decision.mode) {
      case "full":
        return this.store.syncIssues({
          repo: this.repo,
          source: this.source,
          full: true,
          onProgress: options?.onProgress,
        });
      case "incremental":
        return this.store.syncIssues({
          repo: this.repo,
          source: this.source,
          full: false,
          onProgress: options?.onProgress,
        });
      case "hot":
        return this.store.syncHotIssues({
          repo: this.repo,
          source: this.source,
          onProgress: options?.onProgress,
        });
      case "backfill":
        return this.store.runBackfillSlice({
          entity: "issues",
          repo: this.repo,
          source: this.source,
          onProgress: options?.onProgress,
        });
    }
  }

  private async buildPlannerSnapshot(
    entity: PlannerEntity,
    trigger: "manual" | "auto",
  ): Promise<PlannerSnapshot> {
    const status = await this.store.status();
    const rateLimit = await this.safeRateLimit();
    return {
      entity,
      trigger,
      manualOverride: null,
      rateLimit,
      freshness: plannerFreshness(status, entity),
      activeTuiMode: null,
      now: Date.now(),
    };
  }

  private async safeRateLimit() {
    try {
      return await this.rateLimit();
    } catch {
      return null;
    }
  }

  private makeSkippedSummary(
    entity: PlannerEntity,
    reason: "rate_limit_reserve" | "already_fresh" | "backfill_complete",
  ): SyncSummary {
    return {
      mode: "skipped",
      entity,
      repo: `${this.repo.owner}/${this.repo.name}`,
      processedPrs: 0,
      processedIssues: 0,
      skippedPrs: 0,
      skippedIssues: 0,
      docCount: 0,
      commentCount: 0,
      labelCount: 0,
      vectorAvailable: false,
      lastSyncAt: null,
      lastSyncWatermark: null,
      reason,
    };
  }

  async setPrAttentionState(prNumber: number, state: AttentionState | null) {
    await this.store.setPrAttentionState(this.repo, prNumber, state);
  }

  async refreshPrDetail(prNumber: number) {
    await this.store.refreshPullRequestDetail(this.repo, this.source, prNumber);
  }

  async refreshIssueDetail(issueNumber: number) {
    await this.store.refreshIssueDetail(this.repo, this.source, issueNumber);
  }

  async rateLimit() {
    const now = Date.now();
    if (this.rateLimitCache && this.rateLimitCache.expiresAt > now) {
      return this.rateLimitCache.value;
    }
    const value = await this.source.getRateLimitStatus();
    this.rateLimitCache = { value, expiresAt: now + 60_000 };
    return value;
  }
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit/i.test(message);
}

function isPlannerDisabled(): boolean {
  return process.env.CLAWLENS_SYNC_PLANNER === "off";
}

function plannerFreshness(
  status: StatusSnapshot,
  entity: PlannerEntity,
): PlannerSnapshot["freshness"] {
  if (entity === "prs") {
    return {
      lastSyncAt: status.lastSyncAt,
      lastSyncWatermark: status.lastSyncWatermark,
      hotSyncAt: status.prHotSyncAt,
      backfillCursor: status.prBackfillCursor,
      backfillCompletedAt: status.prBackfillCompletedAt,
    };
  }
  return {
    lastSyncAt: status.issueLastSyncAt,
    lastSyncWatermark: status.issueLastSyncWatermark,
    hotSyncAt: status.issueHotSyncAt,
    backfillCursor: status.issueBackfillCursor,
    backfillCompletedAt: status.issueBackfillCompletedAt,
  };
}
