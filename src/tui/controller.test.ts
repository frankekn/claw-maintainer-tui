import { describe, expect, it } from "vitest";
import { TuiController } from "./controller.js";
import type {
  ClusterPullRequestAnalysis,
  IssueSearchResult,
  SearchResult,
  StatusSnapshot,
  SyncSummary,
} from "../types.js";
import type { TuiDataService } from "./types.js";

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
  searchCalls: string[] = [];
  syncBlocked = false;
  syncPrsCalls = 0;
  syncIssuesCalls = 0;
  blockSyncPrs = false;
  private syncPrsRelease: (() => void) | null = null;

  async status() {
    return status;
  }

  async search(query: string) {
    this.searchCalls.push(query);
    return [makePr(41793), makePr(42212)];
  }

  async searchIssues() {
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
      sameClusterCandidates: [],
      nearbyButExcluded: [],
      mergeReadiness: null,
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

  async refreshPrFacts() {
    return;
  }

  releaseSyncPrs(): void {
    this.syncPrsRelease?.();
    this.syncPrsRelease = null;
  }
}

describe("TuiController", () => {
  it("runs PR search and opens the selected PR detail", async () => {
    const service = new FakeTuiDataService();
    const controller = new TuiController(service, {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      ftsOnly: false,
    });

    await controller.initialize();
    await controller.submitQuery("marker spoofing");

    const model = controller.getRenderModel();
    expect(service.searchCalls).toEqual(["marker spoofing"]);
    expect(model.rows).toHaveLength(2);
    expect(model.detailText).toContain("PR #41793");
    expect(model.activeUrl).toBe("https://github.com/openclaw/openclaw/pull/41793");
  });

  it("navigates into PR xref and back out", async () => {
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
    controller.goBack();
    expect(controller.getRenderModel().mode).toBe("pr-search");
    expect(controller.getRenderModel().query).toBe("marker spoofing");
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
    expect(controller.getRenderModel().footer.message).toContain("Synced PRs:");
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
