import { describe, expect, it } from "vitest";
import { TuiController } from "./controller.js";
import type {
  ClusterPullRequestAnalysis,
  IssueSearchResult,
  SearchResult,
  StatusSnapshot,
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
    score: 0.91,
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
        prodFiles: ["a.ts", "b.ts"],
        testFiles: ["a.test.ts", "b.test.ts"],
        otherFiles: ["README.md"],
        relevantProdFiles: ["a.ts"],
        relevantTestFiles: ["a.test.ts"],
        noiseFilesCount: 1,
        status: "best_base",
        reasonCodes: ["broader_relevant_prod_coverage"],
        reason: "broader relevant production coverage",
      },
    ],
    nearbyButExcluded: [],
    mergeReadiness: null,
  };
}

class FakeTuiDataService implements TuiDataService {
  searchCalls: string[] = [];
  issueSearchCalls: string[] = [];
  syncPrsCalls = 0;
  syncIssuesCalls = 0;
  refreshPrDetailCalls: number[] = [];
  refreshIssueDetailCalls: number[] = [];
  verifyClusterCalls: number[] = [];
  syncBlocked = false;
  blockSyncPrs = false;
  private syncPrsRelease: (() => void) | null = null;
  private refreshPrRelease: (() => void) | null = null;

  async status() {
    return status;
  }

  async rateLimit() {
    return rateLimit;
  }

  async search(query: string) {
    this.searchCalls.push(query);
    if (query === "state:open") {
      return [makePr(41793), makePr(42212)];
    }
    return [makePr(41793), makePr(42212, { score: 0.88 })];
  }

  async searchIssues(query: string) {
    this.issueSearchCalls.push(query);
    if (query === "state:open") {
      return [makeIssue(41789)];
    }
    return [makeIssue(41789)];
  }

  async show(prNumber: number) {
    return {
      pr: makePr(prNumber),
      comments: [
        {
          kind: "issue_comment",
          author: "reviewer",
          createdAt: "2026-03-12T02:00:00.000Z",
          url: `https://github.com/openclaw/openclaw/pull/${prNumber}#comment`,
          excerpt: "Comment excerpt",
        },
      ],
    };
  }

  async showIssue(issueNumber: number) {
    return makeIssue(issueNumber);
  }

  async xrefIssue(issueNumber: number) {
    return {
      issue: makeIssue(issueNumber),
      pullRequests: [makePr(42212)],
    };
  }

  async xrefPr(prNumber: number) {
    return {
      pullRequest: makePr(prNumber),
      issues: [makeIssue(41789)],
    };
  }

  async clusterPr(prNumber: number): Promise<ClusterPullRequestAnalysis | null> {
    return makeCluster(prNumber);
  }

  async verifyClusterPr(prNumber: number): Promise<{
    analysis: ClusterPullRequestAnalysis | null;
    summary: {
      verifiedPrCount: number;
      verifiedIssueCount: number;
      missingCount: number;
      state: "idle" | "running" | "done" | "rate_limited";
    };
  }> {
    this.verifyClusterCalls.push(prNumber);
    return {
      analysis: makeCluster(prNumber),
      summary: {
        verifiedPrCount: 2,
        verifiedIssueCount: 1,
        missingCount: 0,
        state: "done",
      },
    };
  }

  async syncPrs() {
    this.syncPrsCalls += 1;
    if (this.syncBlocked) {
      throw new Error("sync blocked");
    }
    if (this.blockSyncPrs) {
      await new Promise<void>((resolve) => {
        this.syncPrsRelease = resolve;
      });
    }
    return syncSummary;
  }

  async syncIssues() {
    this.syncIssuesCalls += 1;
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
}

describe("TuiController", () => {
  it("loads cross-search landing rows on startup", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();

    const model = controller.getRenderModel();
    expect(service.searchCalls).toEqual(["state:open"]);
    expect(service.issueSearchCalls).toEqual(["state:open"]);
    expect(model.mode).toBe("cross-search");
    expect(model.resultTitle).toBe("Cross Search");
    expect(model.rows).toHaveLength(3);
    expect(model.detailTitle).toBe("Start Here");
    expect(model.detailText).toContain("Cross Search is the default investigation desk.");
    expect(model.footer.actions.map((action) => action.label)).toEqual([
      "Search",
      "Detail",
      "Xref",
      "Cluster",
      "Sync PRs",
      "Sync Issues",
      "Refresh",
    ]);
  });

  it("runs cross-search and shows hit-rate summary across pr issue and cluster rows", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.submitQuery("marker spoofing");

    const model = controller.getRenderModel();
    expect(service.searchCalls).toEqual(["state:open", "marker spoofing"]);
    expect(service.issueSearchCalls).toEqual(["state:open", "marker spoofing"]);
    expect(model.rows.map((row) => row.kind)).toEqual(["pr", "pr", "issue", "cluster-candidate"]);
    expect(model.resultTitle).toBe("Cross Search · marker spoofing");
    expect(model.listSummary?.yieldLabel).toBe("4 hits");
    expect(model.listSummary?.confidenceLabel).toContain("PR 2 · Issue 1 · Cluster 1");
    expect(model.listSummary?.coverageLabel).toContain("seed #41793");
  });

  it("opens detail drawer and auto-refreshes selected PR detail", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.submitQuery("marker spoofing");
    const openPromise = controller.openSelected();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const model = controller.getRenderModel();
    expect(model.showDetail).toBe(true);
    expect(model.detailTitle).toBe("PR #41793");
    expect(model.detailText).toContain("Comment excerpt");
    expect(service.refreshPrDetailCalls).toEqual([41793]);

    service.releaseRefreshPr();
    await openPromise;
  });

  it("navigates into PR xref and back out to cross-search", async () => {
    const controller = new TuiController(new FakeTuiDataService(), {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.submitQuery("marker spoofing");
    await controller.crossReferenceSelected();

    expect(controller.getRenderModel().mode).toBe("pr-xref");
    expect(controller.getRenderModel().query).toBe("41793");
    expect(controller.getRenderModel().listSummary?.yieldLabel).toBe("1 related issue");
    expect(controller.getRenderModel().listSummary?.coverageLabel).toBe("source PR #41793");

    controller.goBack();

    expect(controller.getRenderModel().mode).toBe("cross-search");
    expect(controller.getRenderModel().query).toBe("marker spoofing");
  });

  it("uses refresh to verify cluster results on demand", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.submitQuery("marker spoofing");
    await controller.clusterSelected();
    await controller.refreshSelected();

    const model = controller.getRenderModel();
    expect(service.verifyClusterCalls).toEqual([41793]);
    expect(model.mode).toBe("cluster");
    expect(model.listSummary?.coverageLabel).toContain("done");
    expect(model.footer.message).toContain("Verified cluster: 2 PR(s), 1 issue(s).");
  });

  it("locks overlapping sync actions behind the busy state", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    service.blockSyncPrs = true;
    const firstSync = controller.syncPrs();
    await Promise.resolve();
    await controller.syncIssues();

    expect(service.syncPrsCalls).toBe(1);
    expect(service.syncIssuesCalls).toBe(0);
    expect(controller.getRenderModel().footer.message).toContain("Busy:");

    service.releaseSyncPrs();
    await firstSync;

    expect(controller.getRenderModel().footer.message).toContain("Synced PR metadata:");
  });

  it("surfaces sync errors in the header and footer", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    service.syncBlocked = true;
    await controller.syncPrs();

    expect(controller.getRenderModel().footer.message).toContain("sync blocked");
    expect(controller.getRenderModel().header.errorMessage).toBe("sync blocked");
  });
});
