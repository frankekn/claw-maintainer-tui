import { afterEach, describe, expect, it, vi } from "vitest";
import { TuiController } from "./controller.js";
import type {
  AttentionState,
  ClusterFeatureVector,
  ClusterPullRequestAnalysis,
  IssueSearchResult,
  PrContextBundle,
  PriorityCandidate,
  PriorityClusterSummary,
  PriorityInboxItem,
  SearchResult,
  StatusSnapshot,
  SyncProgressEvent,
  SyncSummary,
} from "../types.js";
import type { TuiDataService, TuiRateLimitSnapshot } from "./types.js";

const defaultFeatureVector: ClusterFeatureVector = {
  matchedBy: "linked_issue",
  linkedIssueOverlap: 1,
  linkedIssueCount: 1,
  totalProdFileCount: 1,
  totalTestFileCount: 1,
  totalOtherFileCount: 0,
  relevantProdFileCount: 1,
  relevantTestFileCount: 1,
  noiseFilesCount: 0,
  semanticScore: 0.91,
};

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

function makePriorityCluster(
  prNumbers: number[],
  overrides: Partial<PriorityClusterSummary> = {},
): PriorityClusterSummary {
  const openMembers = prNumbers.map((prNumber, index) =>
    makePriorityCandidate(prNumber, "new", {
      score: 36 - index,
      pr: makePr(prNumber, { score: 36 - index }),
    }),
  );
  return {
    clusterKey: `issue:41789:${prNumbers.join(",")}`,
    basis: "linked_issue",
    representative: openMembers[0]!,
    openMembers,
    score: 40,
    totalPrCount: openMembers.length,
    openPrCount: openMembers.length,
    mergedPrCount: 0,
    linkedIssueCount: 1,
    clusterIssueNumbers: [41789],
    statusLabel: `${openMembers.length} open variants`,
    statusReason: `${openMembers.length} open PRs are competing in the same cluster.`,
    recommendation: "open_variants",
    solvedByPrNumber: null,
    ...overrides,
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
        featureVector: defaultFeatureVector,
      },
    ],
    nearbyButExcluded: [],
    mergeReadiness: null,
    decisionTrace: [],
  };
}

function makeExcludedClusterCandidate(prNumber: number) {
  return {
    prNumber,
    title: `Excluded PR ${prNumber}`,
    url: `https://github.com/openclaw/openclaw/pull/${prNumber}`,
    state: "open" as const,
    updatedAt: "2026-03-09T00:00:00.000Z",
    headSha: `head-${prNumber}`,
    matchedBy: "linked_issue" as const,
    linkedIssues: [41789],
    prodFiles: ["b.ts"],
    testFiles: ["b.test.ts"],
    otherFiles: [],
    relevantProdFiles: [],
    relevantTestFiles: [],
    noiseFilesCount: 1,
    excludedReasonCode: "noise_dominated" as const,
    reason: "mostly unrelated churn",
    featureVector: defaultFeatureVector,
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
  priorityInboxCalls: Array<{ limit: number; scanLimit?: number }> = [];
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
  blockPrContextBundle = false;
  detailErrorMessage: string | null = null;
  inboxItems: PriorityInboxItem[] | null = null;
  private syncPrsRelease: (() => void) | null = null;
  private refreshPrRelease: (() => void) | null = null;
  private priorityQueueRelease: (() => void) | null = null;
  private prContextBundleRelease: (() => void) | null = null;

  async status() {
    return this.statusSnapshot;
  }

  async rateLimit() {
    return rateLimit;
  }

  async listPriorityInbox(options: { limit: number; scanLimit?: number }) {
    this.priorityInboxCalls.push(options);
    if (this.inboxItems) {
      return this.inboxItems.slice(0, options.limit);
    }
    return (await this.listPriorityQueue(options)).map(
      (candidate) => ({ kind: "pr", candidate }) satisfies PriorityInboxItem,
    );
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
    if (this.detailErrorMessage) {
      throw new Error(this.detailErrorMessage);
    }
    if (this.blockPrContextBundle) {
      await new Promise<void>((resolve) => {
        this.prContextBundleRelease = resolve;
      });
    }
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

  releasePrContextBundle(): void {
    this.prContextBundleRelease?.();
    this.prContextBundleRelease = null;
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

    let model = controller.getRenderModel();
    expect(model.mode).toBe("inbox");
    expect(model.resultsPane.title).toBe("Inbox");
    expect(model.resultsPane.rows).toHaveLength(20);
    expect(model.detailPane.lines.join("\n")).toContain("collapsed priority queue");
    expect(service.priorityInboxCalls).toEqual([{ limit: 20, scanLimit: 300 }]);
  });

  it("renders collapsed cluster rows and opens a dedicated cluster workspace", async () => {
    const service = new FakeTuiDataService();
    service.inboxItems = [
      { kind: "cluster", cluster: makePriorityCluster([41793, 42212]) },
      { kind: "pr", candidate: makePriorityCandidate(43001) },
    ];
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    let model = controller.getRenderModel();
    expect(model.resultsPane.rows[0]?.kind).toBe("priority-cluster");
    expect(model.resultsPane.lines.join("\n")).toContain("CLUSTER");

    await controller.expandSelectedCluster();
    model = controller.getRenderModel();
    expect(model.resultsPane.title).toContain("Cluster");
    expect(model.resultsPane.rows[0]?.kind).toBe("cluster-candidate");
    expect(model.resultsPane.lines[0]).toContain("Verify");
    expect(model.detailPane.visible).toBe(true);
    expect(model.detailPane.title).toBe("Cluster · #42212");
    expect(model.detailPane.lines.join("\n")).toContain("CANDIDATE");
  });

  it("toggles excluded candidates inside the cluster workspace", async () => {
    const service = new FakeTuiDataService();
    service.verifyClusterPr = vi.fn(async (prNumber) => ({
      analysis: {
        ...makeCluster(prNumber),
        nearbyButExcluded: [makeExcludedClusterCandidate(43001)],
      },
      summary: {
        verifiedPrCount: 2,
        verifiedIssueCount: 1,
        missingCount: 0,
        state: "done" as const,
      },
    }));
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.expandSelectedCluster();

    let model = controller.getRenderModel();
    expect(model.resultsPane.rows.some((row) => row.kind === "cluster-excluded")).toBe(false);

    await controller.expandSelectedCluster();
    model = controller.getRenderModel();
    expect(model.resultsPane.rows.some((row) => row.kind === "cluster-excluded")).toBe(true);
    expect(model.footer.message).toContain("Showing 1 excluded cluster candidate");

    controller.goBack();
    model = controller.getRenderModel();
    expect(model.resultsPane.title).toBe("Inbox");
    expect(model.resultsPane.rows[0]?.kind).toBe("pr");
  });

  it("opens the cluster workspace when only excluded candidates are available", async () => {
    const service = new FakeTuiDataService();
    service.verifyClusterPr = vi.fn(async (prNumber) => ({
      analysis: {
        ...makeCluster(prNumber),
        bestBase: null,
        sameClusterCandidates: [],
        nearbyButExcluded: [makeExcludedClusterCandidate(43001)],
      },
      summary: {
        verifiedPrCount: 1,
        verifiedIssueCount: 1,
        missingCount: 0,
        state: "done" as const,
      },
    }));
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.expandSelectedCluster();

    let model = controller.getRenderModel();
    expect(model.resultsPane.title).toContain("Cluster");
    expect(model.resultsPane.rows).toHaveLength(1);
    expect(model.resultsPane.rows[0]?.kind).toBe("cluster-excluded");
    expect(model.resultsPane.lines.join("\n")).toContain("EXCLUDED");
    expect(model.detailPane.title).toBe("Cluster · #43001");

    await controller.expandSelectedCluster();
    model = controller.getRenderModel();
    expect(model.resultsPane.rows).toHaveLength(0);
    expect(model.footer.message).toContain("Hid excluded cluster candidates.");
    expect(model.detailPane.visible).toBe(false);
    expect(model.detailPane.title).toBe("Start Here");

    await controller.expandSelectedCluster();
    model = controller.getRenderModel();
    expect(model.resultsPane.rows).toHaveLength(1);
    expect(model.resultsPane.rows[0]?.kind).toBe("cluster-excluded");
  });

  it("refreshes detail when hiding the selected excluded cluster row", async () => {
    const service = new FakeTuiDataService();
    service.verifyClusterPr = vi.fn(async (prNumber) => ({
      analysis: {
        ...makeCluster(prNumber),
        nearbyButExcluded: [makeExcludedClusterCandidate(43001)],
      },
      summary: {
        verifiedPrCount: 2,
        verifiedIssueCount: 1,
        missingCount: 0,
        state: "done" as const,
      },
    }));
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.expandSelectedCluster();
    await controller.expandSelectedCluster();

    controller.moveSelection(1);
    await flushMicrotasks();

    let model = controller.getRenderModel();
    expect(model.resultsPane.rows[1]?.kind).toBe("cluster-excluded");
    expect(model.detailPane.title).toBe("Cluster · #43001");

    await controller.expandSelectedCluster();

    model = controller.getRenderModel();
    expect(model.resultsPane.rows).toHaveLength(1);
    expect(model.resultsPane.rows[0]?.kind).toBe("cluster-candidate");
    expect(model.detailPane.title).toBe("Cluster · #42212");
    expect(model.footer.message).toContain("Hid excluded cluster candidates.");
  });

  it("preserves cluster workspace selection and excluded rows on refresh", async () => {
    const service = new FakeTuiDataService();
    service.verifyClusterPr = vi.fn(async (prNumber) => ({
      analysis: {
        ...makeCluster(prNumber),
        nearbyButExcluded: [makeExcludedClusterCandidate(43001)],
      },
      summary: {
        verifiedPrCount: 2,
        verifiedIssueCount: 1,
        missingCount: 0,
        state: "done" as const,
      },
    }));
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.expandSelectedCluster();
    await controller.expandSelectedCluster();
    controller.moveSelection(1);
    await flushMicrotasks();

    await controller.refreshSelected();

    const model = controller.getRenderModel();
    expect(model.resultsPane.rows).toHaveLength(2);
    expect(model.resultsPane.rows[1]?.kind).toBe("cluster-excluded");
    expect(model.resultsPane.selectedIndex).toBe(1);
    expect(model.detailPane.title).toBe("Cluster · #43001");
  });

  it("keeps detail focus when opening cluster workspace from fullscreen detail", async () => {
    const service = new FakeTuiDataService();
    service.inboxItems = [{ kind: "cluster", cluster: makePriorityCluster([41793, 42212]) }];
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.openSelected();
    await controller.dispatch({ type: "toggle_detail_layout" });

    let model = controller.getRenderModel();
    expect(model.layoutMode).toBe("detail-fullscreen");
    expect(model.focus).toBe("detail");

    await controller.expandSelectedCluster();

    model = controller.getRenderModel();
    expect(model.layoutMode).toBe("detail-fullscreen");
    expect(model.focus).toBe("detail");
    expect(model.resultsPane.rows[0]?.kind).toBe("cluster-candidate");
    expect(model.detailPane.title).toBe("Cluster · #42212");
  });

  it("restores detail focus when going back to fullscreen detail", async () => {
    const service = new FakeTuiDataService();
    service.inboxItems = [{ kind: "cluster", cluster: makePriorityCluster([41793, 42212]) }];
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.openSelected();
    await controller.dispatch({ type: "toggle_detail_layout" });
    await controller.expandSelectedCluster();

    controller.goBack();

    const model = controller.getRenderModel();
    expect(model.layoutMode).toBe("detail-fullscreen");
    expect(model.focus).toBe("detail");
    expect(model.detailPane.visible).toBe(true);
    expect(model.resultsPane.rows[0]?.kind).toBe("priority-cluster");
  });

  it("ignores stale cluster workspace loads after switching modes", async () => {
    const service = new FakeTuiDataService();
    service.inboxItems = [{ kind: "cluster", cluster: makePriorityCluster([41793, 42212]) }];
    let releaseVerify: (() => void) | null = null;
    service.verifyClusterPr = vi.fn(
      async (prNumber): ReturnType<FakeTuiDataService["verifyClusterPr"]> =>
        await new Promise(
          (
            resolve: (value: Awaited<ReturnType<FakeTuiDataService["verifyClusterPr"]>>) => void,
          ) => {
            releaseVerify = () =>
              resolve({
                analysis: makeCluster(prNumber),
                summary: {
                  verifiedPrCount: 2,
                  verifiedIssueCount: 1,
                  missingCount: 0,
                  state: "done" as const,
                },
              });
          },
        ),
    );
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    const expandPromise = controller.expandSelectedCluster();

    controller.activateMode("watchlist");
    releaseVerify!();
    await expandPromise;
    await flushMicrotasks();

    const model = controller.getRenderModel();
    expect(model.mode).toBe("watchlist");
    expect(model.resultsPane.title).toBe("Watchlist");
    expect(model.resultsPane.rows.some((row) => row.kind === "cluster-candidate")).toBe(false);
  });

  it("uses x on a collapsed cluster row to open linked-issue detail", async () => {
    const service = new FakeTuiDataService();
    service.inboxItems = [{ kind: "cluster", cluster: makePriorityCluster([41793, 42212]) }];
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.crossReferenceSelected();

    const model = controller.getRenderModel();
    expect(model.mode).toBe("inbox");
    expect(model.detailPane.visible).toBe(true);
    expect(model.detailPane.anchorKey).not.toBeNull();
    expect(model.detailPane.lines.join("\n")).toContain("LINKED ISSUES");
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
    expect(model.detailPane.visible).toBe(true);
    expect(model.detailPane.title).toBe("PR #41793");
    expect(model.detailPane.lines.join("\n")).toContain("WHY PRIORITIZED");
    expect(model.detailPane.lines.join("\n")).toContain("LINKED ISSUES");

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
    expect(model.detailPane.visible).toBe(true);
    expect(model.detailPane.anchorKey).not.toBeNull();
    expect(model.detailPane.lines.join("\n")).toContain("LINKED ISSUES");

    await controller.clusterSelected();
    model = controller.getRenderModel();
    expect(model.mode).toBe("inbox");
    expect(model.detailPane.anchorKey).not.toBeNull();
    expect(model.detailPane.lines.join("\n")).toContain("CLUSTER");
  });

  it("starts Sparse Extras collapsed and can expand it in detail", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.openSelected();

    let model = controller.getRenderModel();
    expect(model.detailPane.lines.join("\n")).toContain("SPARSE EXTRAS");
    expect(model.detailPane.lines.join("\n")).toContain("[collapsed]");
    expect(model.detailPane.lines.join("\n")).not.toContain("recent_comments");

    controller.focusNext();
    await controller.dispatch({ type: "toggle_detail_section_fold" });

    model = controller.getRenderModel();
    expect(model.detailPane.lines.join("\n")).toContain("recent_comments");
    expect(model.footer.message).toContain("Sparse Extras expanded");
  });

  it("collapses the focused linked-issues section from detail focus", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.crossReferenceSelected();
    controller.focusNext();
    await controller.dispatch({ type: "toggle_detail_section_fold" });

    const model = controller.getRenderModel();
    expect(model.detailPane.lines.join("\n")).toContain("LINKED ISSUES");
    expect(model.detailPane.lines.join("\n")).toContain("[collapsed]");
    expect(model.detailPane.lines.join("\n")).not.toContain("Issue #41789");
    expect(model.footer.message).toContain("Linked Issues collapsed");
  });

  it("toggles detail fullscreen and resizes split detail panes", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.openSelected();

    let model = controller.getRenderModel();
    expect(model.layoutMode).toBe("split-pane");
    expect(model.detailWidth).toBe("36%");

    await controller.dispatch({ type: "resize_detail", delta: 1 });
    model = controller.getRenderModel();
    expect(model.layoutMode).toBe("split-pane");
    expect(model.detailWidth).toBe("42%");

    await controller.dispatch({ type: "toggle_detail_layout" });
    model = controller.getRenderModel();
    expect(model.layoutMode).toBe("detail-fullscreen");
    expect(model.detailWidth).toBe("100%");

    await controller.dispatch({ type: "toggle_detail_layout" });
    model = controller.getRenderModel();
    expect(model.layoutMode).toBe("split-pane");
    expect(model.detailWidth).toBe("42%");
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
    const replayPromise = controller.replayActiveList();
    await flushMicrotasks();

    await controller.openSelected();
    service.blockPriorityQueue = false;
    service.releasePriorityQueue();
    await replayPromise;

    const model = controller.getRenderModel();
    expect(model.detailPane.visible).toBe(false);
    expect(model.detailPane.title).toBe("Start Here");
    expect(model.detailPane.lines.join("\n")).toContain("collapsed priority queue");

    service.releaseRefreshPr();
    await openPromise;
  });

  it("does not reopen detail if a pending detail load finishes after closing it", async () => {
    const service = new FakeTuiDataService();
    service.blockPrContextBundle = true;
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    const openPromise = controller.openSelected();
    await flushMicrotasks();

    await controller.openSelected();
    service.blockPrContextBundle = false;
    service.releasePrContextBundle();
    await openPromise;

    const model = controller.getRenderModel();
    expect(model.detailPane.visible).toBe(false);
    expect(model.layoutMode).toBe("single-pane");
    expect(model.detailPane.title).toBe("Start Here");
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
    expect(model.resultsPane.rows).toHaveLength(1);
    expect(model.resultsPane.rows[0]?.kind).toBe("pr");
  });

  it("keeps dismissed banners hidden after busy refreshes finish", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.toggleWatchSelected();
    expect(controller.getRenderModel().footer.banner?.message).toContain("watch");

    controller.dismissBanner();
    expect(controller.getRenderModel().footer.banner).toBeNull();

    const refreshPromise = controller.refreshSelected();
    await flushMicrotasks();
    expect(controller.getRenderModel().footer.banner?.message).toContain("[REFRESHING]");

    service.releaseRefreshPr();
    await refreshPromise;

    expect(controller.getRenderModel().footer.banner).toBeNull();
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

    const inboxRows = controller.getRenderModel().resultsPane.rows;
    expect(inboxRows.some((row) => row.kind === "pr" && row.pr.prNumber === 41793)).toBe(false);

    controller.activateMode("pr-search");
    await flushMicrotasks();
    expect(controller.getRenderModel().resultsPane.rows[0]?.kind).toBe("pr");
  });

  it("marks the visible page as seen and can undo the batch change", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.markVisiblePageSeen();

    expect(service.attentionState.get(41793)).toBe("seen");
    expect(service.attentionState.get(41812)).toBe("seen");
    expect(controller.getRenderModel().footer.actions.some((action) => action.id === "undo")).toBe(
      true,
    );

    await controller.undoAttentionState();

    expect(service.attentionState.has(41793)).toBe(false);
    expect(service.attentionState.has(41812)).toBe(false);
    expect(controller.getRenderModel().footer.banner?.message).toContain("Undid triage change");
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

    expect(controller.getRenderModel().resultsPane.rows).toHaveLength(40);
    expect(service.priorityQueueCalls.at(-1)).toEqual({ limit: 40, scanLimit: 300 });
  });

  it("restores browse limit when navigating back", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.loadMore();
    controller.activateMode("watchlist");
    await flushMicrotasks();
    controller.goBack();

    const model = controller.getRenderModel();
    expect(model.resultsPane.rows).toHaveLength(40);
    expect(model.resultsPane.summary?.yieldLabel).toBe("40 rows · 40 PRs · 40 shown");
  });

  it("sorts cross-search rows by score before entity type", async () => {
    const service = new FakeTuiDataService();
    service.search = vi.fn(async () => [makePr(41793, { score: 0.1 })]);
    service.searchIssues = vi.fn(async () => [makeIssue(41789, { score: 0.9 })]);
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    controller.activateMode("cross-search");
    await flushMicrotasks();

    const rows = controller.getRenderModel().resultsPane.rows;
    expect(rows[0]?.kind).toBe("issue");
    expect(rows[1]?.kind).toBe("pr");
  });

  it("keeps cross-search pagination enabled when one result type hits its cap", async () => {
    const service = new FakeTuiDataService();
    service.search = vi.fn(async () =>
      Array.from({ length: 10 }, (_, index) => makePr(50000 + index, { score: 0.9 - index / 100 })),
    );
    service.searchIssues = vi.fn(async () => []);
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    controller.activateMode("cross-search");
    await flushMicrotasks();

    const loadMore = controller
      .getRenderModel()
      .footer.actions.find((action) => action.id === "load-more");
    expect(loadMore?.enabled).toBe(true);
  });

  it("recalls the newest query first in history navigation", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    controller.activateMode("cross-search");
    await flushMicrotasks();
    await controller.submitQuery("author:frank");
    await controller.submitQuery("state:open");

    controller.startQueryEntry();
    controller.appendQueryCharacter(" ");

    controller.moveQueryHistory(-1);
    expect(controller.getRenderModel().query).toBe("state:open");

    controller.moveQueryHistory(-1);
    expect(controller.getRenderModel().query).toBe("author:frank");

    controller.moveQueryHistory(1);
    expect(controller.getRenderModel().query).toBe("state:open");

    controller.moveQueryHistory(1);
    expect(controller.getRenderModel().query).toBe("state:open ");
  });

  it("restores saved query history when going back to a search view", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    controller.activateMode("cross-search");
    await flushMicrotasks();
    await controller.submitQuery("author:frank");

    controller.activateMode("watchlist");
    await flushMicrotasks();
    controller.activateMode("cross-search");
    await flushMicrotasks();
    await controller.submitQuery("state:open");

    controller.goBack();
    controller.goBack();

    expect(controller.getRenderModel().mode).toBe("cross-search");
    expect(controller.getRenderModel().query).toBe("author:frank");

    controller.startQueryEntry();
    controller.moveQueryHistory(-1);

    expect(controller.getRenderModel().query).toBe("author:frank");
  });

  it("does not duplicate browse guidance in the footer query line", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();

    const model = controller.getRenderModel();
    expect(model.footer.queryPlaceholder).toContain("Browse-only mode");
    expect(model.footer.queryHelpText).toBe("");
  });

  it("keeps inbox pagination enabled when collapsed clusters compress visible rows", async () => {
    const service = new FakeTuiDataService();
    service.listPriorityInbox = vi.fn(async ({ limit }) =>
      limit <= 20
        ? [{ kind: "cluster" as const, cluster: makePriorityCluster([41793, 42212]) }]
        : [
            { kind: "cluster" as const, cluster: makePriorityCluster([41793, 42212]) },
            { kind: "cluster" as const, cluster: makePriorityCluster([43001, 43002]) },
          ],
    );
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();

    const initialLoadMore = controller
      .getRenderModel()
      .footer.actions.find((action) => action.id === "load-more");
    expect(initialLoadMore?.enabled).toBe(true);

    await controller.loadMore();

    expect(controller.getRenderModel().resultsPane.rows).toHaveLength(2);
  });

  it("catches replay refresh failures instead of leaving unhandled rejections", async () => {
    vi.useFakeTimers();
    let controller: TuiController | null = null;
    try {
      const service = new FakeTuiDataService();
      controller = new TuiController(service, {
        repo: "openclaw/openclaw",
        dbPath: "/tmp/clawlens.sqlite",
        ftsOnly: false,
      });

      await controller.initialize();
      vi.spyOn(service, "listPriorityInbox").mockRejectedValue(new Error("replay boom"));

      (
        controller as unknown as {
          scheduleListReplay: () => void;
        }
      ).scheduleListReplay();

      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();

      const model = controller.getRenderModel();
      expect(model.header.errorMessage).toBe("replay boom");
      expect(model.footer.message).toBe("replay boom");
    } finally {
      controller?.dispose();
      vi.useRealTimers();
    }
  });

  it("replays deferred list refresh after leaving cluster workspace", async () => {
    vi.useFakeTimers();
    let controller: TuiController | null = null;
    try {
      const service = new FakeTuiDataService();
      service.statusSnapshot = {
        ...service.statusSnapshot,
        lastSyncAt: new Date().toISOString(),
        issueLastSyncAt: new Date().toISOString(),
      };
      service.inboxItems = [{ kind: "cluster", cluster: makePriorityCluster([41793, 42212]) }];
      controller = new TuiController(service, {
        repo: "openclaw/openclaw",
        dbPath: "/tmp/clawlens.sqlite",
        ftsOnly: false,
      });

      await controller.initialize();
      await controller.expandSelectedCluster();
      service.inboxItems = [{ kind: "pr", candidate: makePriorityCandidate(43001) }];

      (
        controller as unknown as {
          scheduleListReplay: () => void;
        }
      ).scheduleListReplay();

      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();

      let model = controller.getRenderModel();
      expect(model.resultsPane.title).toContain("Cluster");

      controller.goBack();
      await flushMicrotasks(6);

      model = controller.getRenderModel();
      expect(model.mode).toBe("inbox");
      expect(model.resultsPane.rows).toHaveLength(1);
      expect(model.resultsPane.rows[0]?.kind).toBe("pr");
      if (model.resultsPane.rows[0]?.kind === "pr") {
        expect(model.resultsPane.rows[0].pr.prNumber).toBe(43001);
      }
    } finally {
      controller?.dispose();
      vi.useRealTimers();
    }
  });

  it("surfaces detail load failures instead of rejecting the action", async () => {
    const service = new FakeTuiDataService();
    service.detailErrorMessage = "detail boom";
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await expect(controller.openSelected()).resolves.toBeUndefined();

    const model = controller.getRenderModel();
    expect(model.header.errorMessage).toBe("detail boom");
    expect(model.footer.message).toBe("detail boom");
    expect(model.header.detailAutoRefreshInFlight).toBe(false);
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

  it("disposes timers and suppresses follow-up emits", async () => {
    vi.useFakeTimers();
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });
    const listener = vi.fn();
    controller.subscribe(listener);

    await controller.initialize();
    listener.mockClear();
    controller.dispose();
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(listener).not.toHaveBeenCalled();
  });
});
