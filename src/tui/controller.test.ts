import { afterEach, describe, expect, it, vi } from "vitest";
import { TuiController } from "./controller.js";
import type {
  AttentionState,
  ClusterPullRequestAnalysis,
  IssueSearchResult,
  PrContextBundle,
  PriorityCandidate,
  SearchResult,
  StatusSnapshot,
  SyncProgressEvent,
  SyncSummary,
} from "../types.js";
import type { TuiDataService, TuiRateLimitSnapshot } from "./types.js";

function makePr(prNumber: number, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    prNumber,
    title: `PR ${prNumber}`,
    url: `https://github.com/openclaw/openclaw/pull/${prNumber}`,
    state: "open",
    author: "frank",
    labels: [],
    updatedAt: "2026-03-12T00:00:00.000Z",
    score: 12,
    matchedDocKind: "pr_body",
    matchedExcerpt: `Matched excerpt for PR ${prNumber}`,
    ...overrides,
  };
}

function makeIssue(
  issueNumber: number,
  overrides: Partial<IssueSearchResult> = {},
): IssueSearchResult {
  return {
    issueNumber,
    title: `Issue ${issueNumber}`,
    url: `https://github.com/openclaw/openclaw/issues/${issueNumber}`,
    state: "open",
    author: "frank",
    labels: [],
    updatedAt: "2026-03-12T00:00:00.000Z",
    score: 0.88,
    matchedExcerpt: `Matched excerpt for issue ${issueNumber}`,
    ...overrides,
  };
}

function makePriorityCandidate(
  prNumber: number,
  attentionState: AttentionState | "new" = "new",
  overrides: Partial<PriorityCandidate> = {},
): PriorityCandidate {
  const score = attentionState === "watch" ? 42 : 28;
  return {
    pr: makePr(prNumber, {
      score,
      labels: overrides.badges?.maintainer ? ["maintainer"] : [],
    }),
    attentionState,
    score,
    reasons: [
      { type: "freshness", label: "updated in the last 24h", points: 10 },
      { type: "linked_issue", label: "links 1 issue", points: 12 },
    ],
    linkedIssueCount: 1,
    relatedPullRequestCount: 2,
    badges: {
      draft: false,
      maintainer: false,
    },
    ...overrides,
  };
}

function makeBundle(
  prNumber: number,
  attentionState: AttentionState | "new" = "new",
): PrContextBundle {
  return {
    candidate: makePriorityCandidate(prNumber, attentionState),
    comments: [
      {
        kind: "issue_comment",
        author: "reviewer",
        createdAt: "2026-03-12T02:00:00.000Z",
        url: `https://github.com/openclaw/openclaw/pull/${prNumber}#comment`,
        excerpt: "Comment excerpt",
      },
    ],
    linkedIssues: [makeIssue(41789)],
    relatedPullRequests: [makePr(42212, { score: 0.91 })],
    cluster: makeCluster(prNumber),
    latestReviewFact: null,
    mergeReadiness: null,
  };
}

function makeCluster(prNumber: number): ClusterPullRequestAnalysis {
  return {
    seedPr: {
      prNumber,
      title: `PR ${prNumber}`,
      url: `https://github.com/openclaw/openclaw/pull/${prNumber}`,
      state: "open",
      updatedAt: "2026-03-12T00:00:00.000Z",
    },
    clusterBasis: "linked_issue",
    clusterIssueNumbers: [41789],
    bestBase: null,
    sameClusterCandidates: [
      {
        prNumber: 42212,
        title: "fix: prune image-containing tool results",
        url: "https://github.com/openclaw/openclaw/pull/42212",
        state: "open",
        updatedAt: "2026-03-10T00:00:00.000Z",
        headSha: "head-42212",
        matchedBy: "linked_issue",
        linkedIssues: [41789],
        prodFiles: ["a.ts"],
        testFiles: ["a.test.ts"],
        otherFiles: [],
        relevantProdFiles: ["a.ts"],
        relevantTestFiles: ["a.test.ts"],
        noiseFilesCount: 0,
        status: "best_base",
        reasonCodes: ["broader_relevant_prod_coverage"],
        reason: "broader relevant production coverage",
      },
    ],
    nearbyButExcluded: [],
    mergeReadiness: null,
  };
}

const status: StatusSnapshot = {
  repo: "openclaw/openclaw",
  lastSyncAt: "2026-03-11T07:28:13.832Z",
  lastSyncWatermark: "2026-03-11T07:28:13.832Z",
  issueLastSyncAt: "2026-03-11T07:43:23.912Z",
  issueLastSyncWatermark: "2026-03-11T07:43:23.912Z",
  prCount: 23935,
  issueCount: 17535,
  labelCount: 61148,
  issueLabelCount: 14230,
  commentCount: 100,
  docCount: 24035,
  vectorEnabled: true,
  vectorAvailable: true,
  vectorError: undefined,
  embeddingModel: "hf:test",
};

const rateLimit: TuiRateLimitSnapshot = {
  limit: 5000,
  remaining: 0,
  resetAt: "2026-03-12T09:17:43.000Z",
};

const syncSummary: SyncSummary = {
  mode: "incremental",
  entity: "prs",
  repo: "openclaw/openclaw",
  processedPrs: 2,
  processedIssues: 0,
  skippedPrs: 1,
  skippedIssues: 0,
  docCount: 10,
  commentCount: 3,
  labelCount: 6,
  vectorAvailable: true,
  lastSyncAt: "2026-03-12T01:00:00.000Z",
  lastSyncWatermark: "2026-03-12T01:00:00.000Z",
};

class FakeTuiDataService implements TuiDataService {
  syncPrsCalls = 0;
  syncIssuesCalls = 0;
  priorityQueueCalls: Array<{ limit: number; scanLimit?: number }> = [];
  watchlistCalls: number[] = [];
  searchCalls: Array<{ query: string; limit: number }> = [];
  issueSearchCalls: Array<{ query: string; limit: number }> = [];
  refreshPrDetailCalls: number[] = [];
  refreshIssueDetailCalls: number[] = [];
  attentionState = new Map<number, AttentionState>();
  statusSnapshot: StatusSnapshot = { ...status };
  syncBlocked = false;
  blockSyncPrs = false;
  blockPriorityQueue = false;
  private syncPrsRelease: (() => void) | null = null;
  private refreshPrRelease: (() => void) | null = null;
  private priorityQueueRelease: (() => void) | null = null;

  async status() {
    return this.statusSnapshot;
  }

  async rateLimit() {
    return rateLimit;
  }

  async listPriorityQueue(options: { limit: number; scanLimit?: number }) {
    this.priorityQueueCalls.push(options);
    if (this.blockPriorityQueue) {
      await new Promise<void>((resolve) => {
        this.priorityQueueRelease = resolve;
      });
    }
    return Array.from({ length: options.limit }, (_, index) => {
      const prNumber = 41793 + index;
      const state = this.attentionState.get(prNumber) ?? undefined;
      if (state === "ignore") {
        return null;
      }
      return makePriorityCandidate(prNumber, state ?? "new", {
        badges: { draft: false, maintainer: prNumber === 41793 },
      });
    }).filter((candidate): candidate is PriorityCandidate => Boolean(candidate));
  }

  async listWatchlist(limit: number) {
    this.watchlistCalls.push(limit);
    return Array.from(this.attentionState.entries())
      .filter(([, value]) => value === "watch")
      .slice(0, limit)
      .map(([prNumber]) => makePriorityCandidate(prNumber, "watch"));
  }

  async search(query: string, limit: number) {
    this.searchCalls.push({ query, limit });
    if (query === "state:open") {
      return Array.from({ length: limit }, (_, index) => makePr(43000 + index));
    }
    return [makePr(41793), makePr(42212, { score: 0.88 })];
  }

  async searchIssues(query: string, limit: number) {
    this.issueSearchCalls.push({ query, limit });
    if (query === "state:open") {
      return Array.from({ length: limit }, (_, index) => makeIssue(52000 + index));
    }
    return [makeIssue(41789)];
  }

  async getPrContextBundle(prNumber: number) {
    return makeBundle(prNumber, this.attentionState.get(prNumber) ?? "new");
  }

  async setPrAttentionState(prNumber: number, state: AttentionState | null) {
    if (state === null) {
      this.attentionState.delete(prNumber);
      return;
    }
    this.attentionState.set(prNumber, state);
  }

  async show(prNumber: number) {
    return {
      pr: makePr(prNumber),
      comments: makeBundle(prNumber).comments,
    };
  }

  async showIssue(issueNumber: number) {
    return makeIssue(issueNumber);
  }

  async xrefIssue(issueNumber: number) {
    return { issue: makeIssue(issueNumber), pullRequests: [makePr(42212)] };
  }

  async xrefPr(prNumber: number) {
    return { pullRequest: makePr(prNumber), issues: [makeIssue(41789)] };
  }

  async clusterPr(prNumber: number): Promise<ClusterPullRequestAnalysis | null> {
    return makeCluster(prNumber);
  }

  async verifyClusterPr(prNumber: number) {
    return {
      analysis: makeCluster(prNumber),
      summary: {
        verifiedPrCount: 2,
        verifiedIssueCount: 1,
        missingCount: 0,
        state: "done" as const,
      },
    };
  }

  async syncPrs(options?: { onProgress?: (event: SyncProgressEvent) => void }) {
    this.syncPrsCalls += 1;
    options?.onProgress?.({
      entity: "prs",
      phase: "syncing",
      processed: 1,
      skipped: 0,
      queued: 1,
      totalKnown: 2,
      currentId: 41793,
      currentTitle: "PR 41793",
    });
    if (this.syncBlocked) {
      throw new Error("sync blocked");
    }
    if (this.blockSyncPrs) {
      await new Promise<void>((resolve) => {
        this.syncPrsRelease = resolve;
      });
    }
    this.statusSnapshot = {
      ...this.statusSnapshot,
      lastSyncAt: "2026-03-12T01:00:00.000Z",
      lastSyncWatermark: "2026-03-12T01:00:00.000Z",
    };
    return syncSummary;
  }

  async syncIssues(options?: { onProgress?: (event: SyncProgressEvent) => void }) {
    this.syncIssuesCalls += 1;
    options?.onProgress?.({
      entity: "issues",
      phase: "syncing",
      processed: 1,
      skipped: 0,
      queued: 2,
      totalKnown: 3,
      currentId: 41789,
      currentTitle: "Issue 41789",
    });
    this.statusSnapshot = {
      ...this.statusSnapshot,
      issueLastSyncAt: "2026-03-12T01:00:00.000Z",
      issueLastSyncWatermark: "2026-03-12T01:00:00.000Z",
    };
    return {
      ...syncSummary,
      entity: "issues" as const,
      processedPrs: 0,
      processedIssues: 3,
    };
  }

  async refreshPrDetail(prNumber: number) {
    this.refreshPrDetailCalls.push(prNumber);
    await new Promise<void>((resolve) => {
      this.refreshPrRelease = resolve;
    });
  }

  async refreshIssueDetail(issueNumber: number) {
    this.refreshIssueDetailCalls.push(issueNumber);
  }

  releaseSyncPrs(): void {
    this.syncPrsRelease?.();
    this.syncPrsRelease = null;
  }

  releaseRefreshPr(): void {
    this.refreshPrRelease?.();
    this.refreshPrRelease = null;
  }

  releasePriorityQueue(): void {
    this.priorityQueueRelease?.();
    this.priorityQueueRelease = null;
  }
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe("TuiController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads Inbox on startup", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();

    const model = controller.getRenderModel();
    expect(model.mode).toBe("inbox");
    expect(model.resultTitle).toBe("Inbox");
    expect(model.rows).toHaveLength(20);
    expect(model.detailText).toContain("Inbox ranks PRs");
    expect(service.priorityQueueCalls).toEqual([{ limit: 20, scanLimit: 300 }]);
  });

  it("opens PR context detail from Inbox", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    const openPromise = controller.openSelected();
    await flushMicrotasks();

    const model = controller.getRenderModel();
    expect(model.showDetail).toBe(true);
    expect(model.detailTitle).toBe("PR #41793");
    expect(model.detailText).toContain("WHY PRIORITIZED");
    expect(model.detailText).toContain("LINKED ISSUES");

    service.releaseRefreshPr();
    await openPromise;
  });

  it("uses x and c to jump within detail without changing mode", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.crossReferenceSelected();

    let model = controller.getRenderModel();
    expect(model.mode).toBe("inbox");
    expect(model.showDetail).toBe(true);
    expect(model.detailAnchorKey).not.toBeNull();
    expect(model.detailText).toContain("LINKED ISSUES");

    await controller.clusterSelected();
    model = controller.getRenderModel();
    expect(model.mode).toBe("inbox");
    expect(model.detailAnchorKey).not.toBeNull();
    expect(model.detailText).toContain("CLUSTER");
  });

  it("does not reopen detail if a background list replay finishes after closing it", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    const openPromise = controller.openSelected();
    await flushMicrotasks();

    service.blockPriorityQueue = true;
    const replayPromise = (controller as any).refreshActiveListPreservingUi();
    await flushMicrotasks();

    await controller.openSelected();
    service.blockPriorityQueue = false;
    service.releasePriorityQueue();
    await replayPromise;

    const model = controller.getRenderModel();
    expect(model.showDetail).toBe(false);
    expect(model.detailTitle).toBe("Start Here");
    expect(model.detailText).toContain("Inbox ranks PRs");

    service.releaseRefreshPr();
    await openPromise;
  });

  it("toggles watch state and shows it in Watchlist", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.toggleWatchSelected();

    expect(service.attentionState.get(41793)).toBe("watch");

    controller.activateMode("watchlist");
    await flushMicrotasks();

    const model = controller.getRenderModel();
    expect(model.mode).toBe("watchlist");
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]?.kind).toBe("pr");
  });

  it("ignores PRs in Inbox without hiding them from other desks", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.toggleIgnoreSelected();

    const inboxRows = controller.getRenderModel().rows;
    expect(inboxRows.some((row) => row.kind === "pr" && row.pr.prNumber === 41793)).toBe(false);

    controller.activateMode("pr-search");
    await flushMicrotasks();
    expect(controller.getRenderModel().rows[0]?.kind).toBe("pr");
  });

  it("loads more Inbox rows in batches of 20", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.loadMore();

    expect(controller.getRenderModel().rows).toHaveLength(40);
    expect(service.priorityQueueCalls.at(-1)).toEqual({ limit: 40, scanLimit: 300 });
  });

  it("queues overlapping sync actions without blocking the UI", async () => {
    vi.useFakeTimers();
    const service = new FakeTuiDataService();
    service.statusSnapshot = {
      ...service.statusSnapshot,
      lastSyncAt: new Date().toISOString(),
      issueLastSyncAt: new Date().toISOString(),
    };
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    service.blockSyncPrs = true;
    controller.syncPrs();
    await flushMicrotasks();
    await controller.syncIssues();
    await flushMicrotasks();

    expect(service.syncPrsCalls).toBe(1);
    expect(service.syncIssuesCalls).toBe(0);
    expect(controller.getRenderModel().busy).toBe(false);
    expect(
      controller.getRenderModel().header.syncJobs.find((job) => job.entity === "prs")?.state,
    ).toBe("running");
    expect(
      controller.getRenderModel().header.syncJobs.find((job) => job.entity === "issues")?.state,
    ).toBe("queued");

    service.releaseSyncPrs();
    await flushMicrotasks();
    expect(service.syncIssuesCalls).toBe(1);
  });

  it("auto syncs stale PR metadata for Inbox", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));
    const service = new FakeTuiDataService();
    service.statusSnapshot = {
      ...service.statusSnapshot,
      lastSyncAt: "2026-03-12T23:45:00.000Z",
      issueLastSyncAt: "2026-03-13T00:00:00.000Z",
    };
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    vi.advanceTimersByTime(16 * 60 * 1000);
    controller.activateMode("inbox");
    await flushMicrotasks();

    expect(service.syncPrsCalls).toBe(1);
  });

  it("shows metadata sync progress without blocking the UI", async () => {
    const service = new FakeTuiDataService();
    service.statusSnapshot = {
      ...service.statusSnapshot,
      lastSyncAt: new Date().toISOString(),
      issueLastSyncAt: new Date().toISOString(),
    };
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    service.blockSyncPrs = true;
    await controller.syncPrs();
    await flushMicrotasks();

    const job = controller.getRenderModel().header.syncJobs.find((item) => item.entity === "prs");
    expect(job?.progress?.processed).toBe(1);
    expect(controller.getRenderModel().footer.message).toContain("Syncing PR metadata: 1/2");

    service.releaseSyncPrs();
  });
});
