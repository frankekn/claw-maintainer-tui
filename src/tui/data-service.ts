import { GhCliPullRequestDataSource } from "../github.js";
import { PrIndexStore } from "../store.js";
import type { AttentionState, RepoRef } from "../types.js";
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

  syncPrs(options?: { onProgress?: (event: SyncProgressEvent) => void }) {
    return this.store.sync({
      repo: this.repo,
      source: this.source,
      full: false,
      hydrateAll: false,
      onProgress: options?.onProgress,
    });
  }

  syncIssues(options?: { onProgress?: (event: SyncProgressEvent) => void }) {
    return this.store.syncIssues({
      repo: this.repo,
      source: this.source,
      full: false,
      onProgress: options?.onProgress,
    });
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
