import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as embeddingModule from "./embedding.js";
import { PrIndexStore } from "./store.js";
import type {
  HydratedPullRequest,
  IssueDataSource,
  IssueRecord,
  PullRequestCommentRecord,
  PullRequestDataSource,
  PullRequestFactRecord,
  PullRequestRecord,
  PullRequestReviewFact,
  RepoRef,
} from "./types.js";

const repo: RepoRef = { owner: "openclaw", name: "openclaw" };
const MISSING_MODEL = "/tmp/clawlens-missing-model.gguf";

class FakePullRequestDataSource implements PullRequestDataSource {
  private readonly hydrated = new Map<number, HydratedPullRequest>();
  private readonly facts = new Map<number, PullRequestFactRecord>();
  private readonly searchResults = new Map<string, number[]>();
  changedPrNumbers: number[] = [];
  changedPrs: PullRequestRecord[] = [];
  hydrateCalls: number[] = [];

  constructor(items: HydratedPullRequest[]) {
    for (const item of items) {
      this.hydrated.set(item.pr.number, item);
    }
  }

  setPullRequest(item: HydratedPullRequest): void {
    this.hydrated.set(item.pr.number, item);
  }

  setFacts(item: PullRequestFactRecord): void {
    this.facts.set(item.prNumber, item);
  }

  setSearchResults(query: string, state: "open" | "closed", prNumbers: number[]): void {
    this.searchResults.set(`${state}:${query}`, [...prNumbers]);
  }

  async *listAllPullRequests(_repo: RepoRef): AsyncGenerator<PullRequestRecord> {
    const items = Array.from(this.hydrated.values()).sort((a, b) => a.pr.number - b.pr.number);
    for (const item of items) {
      yield item.pr;
    }
  }

  async listChangedPullRequestNumbersSince(_repo: RepoRef, _since: string): Promise<number[]> {
    return [...this.changedPrNumbers];
  }

  async listChangedPullRequestsSince(_repo: RepoRef, _since: string): Promise<PullRequestRecord[]> {
    return [...this.changedPrs];
  }

  async hydratePullRequest(_repo: RepoRef, prNumber: number): Promise<HydratedPullRequest> {
    this.hydrateCalls.push(prNumber);
    const payload = this.hydrated.get(prNumber);
    if (!payload) {
      throw new Error(`missing PR ${prNumber}`);
    }
    return payload;
  }

  async fetchPullRequestFacts(_repo: RepoRef, prNumber: number): Promise<PullRequestFactRecord> {
    const payload = this.facts.get(prNumber);
    if (!payload) {
      throw new Error(`missing facts for PR ${prNumber}`);
    }
    return payload;
  }

  async searchPullRequestNumbers(
    _repo: RepoRef,
    query: string,
    options: { state: "open" | "closed"; limit: number },
  ): Promise<number[]> {
    return [...(this.searchResults.get(`${options.state}:${query}`) ?? [])].slice(0, options.limit);
  }
}

class FakeIssueDataSource implements IssueDataSource {
  private readonly issues = new Map<number, IssueRecord>();
  changedIssueNumbers: number[] = [];
  changedIssues: IssueRecord[] = [];
  getIssueCalls: number[] = [];

  constructor(items: IssueRecord[]) {
    for (const item of items) {
      this.issues.set(item.number, item);
    }
  }

  setIssue(item: IssueRecord): void {
    this.issues.set(item.number, item);
  }

  async *listAllIssues(_repo: RepoRef): AsyncGenerator<IssueRecord> {
    const items = Array.from(this.issues.values()).sort((a, b) => a.number - b.number);
    for (const item of items) {
      yield item;
    }
  }

  async listChangedIssueNumbersSince(_repo: RepoRef, _since: string): Promise<number[]> {
    return [...this.changedIssueNumbers];
  }

  async listChangedIssuesSince(_repo: RepoRef, _since: string): Promise<IssueRecord[]> {
    return [...this.changedIssues];
  }

  async getIssue(_repo: RepoRef, issueNumber: number): Promise<IssueRecord> {
    this.getIssueCalls.push(issueNumber);
    const payload = this.issues.get(issueNumber);
    if (!payload) {
      throw new Error(`missing issue ${issueNumber}`);
    }
    return payload;
  }
}

function makeComment(
  sourceId: string,
  body: string,
  overrides: Partial<PullRequestCommentRecord> = {},
): PullRequestCommentRecord {
  return {
    sourceId,
    kind: "issue_comment",
    author: "reviewer",
    body,
    path: null,
    url: `https://github.com/openclaw/openclaw/pull/1#${sourceId}`,
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    ...overrides,
  };
}

function makePullRequest(
  number: number,
  overrides: Partial<PullRequestRecord> = {},
): HydratedPullRequest {
  const pr: PullRequestRecord = {
    number,
    title: `PR ${number}`,
    body: `Body for PR ${number}`,
    state: "open",
    isDraft: false,
    author: "frank",
    baseRef: "main",
    headRef: `branch-${number}`,
    url: `https://github.com/openclaw/openclaw/pull/${number}`,
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    labels: [],
    ...overrides,
  };

  return {
    pr,
    comments: [],
  };
}

function makeIssue(number: number, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body for issue ${number}`,
    state: "open",
    author: "frank",
    url: `https://github.com/openclaw/openclaw/issues/${number}`,
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    closedAt: null,
    labels: [],
    ...overrides,
  };
}

function makePullRequestFacts(
  prNumber: number,
  overrides: Partial<PullRequestFactRecord> = {},
): PullRequestFactRecord {
  return {
    prNumber,
    headSha: `head-${prNumber}`,
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    statusChecks: [],
    linkedIssues: [],
    changedFiles: [],
    fetchedAt: "2026-03-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeReviewFact(
  prNumber: number,
  overrides: Partial<PullRequestReviewFact> = {},
): PullRequestReviewFact {
  return {
    repo: "openclaw/openclaw",
    prNumber,
    headSha: `head-${prNumber}`,
    decision: "needs_work",
    summary: "Existing contract test still fails.",
    commands: [],
    failingTests: [],
    source: "manual",
    recordedAt: "2026-03-11T00:00:00.000Z",
    ...overrides,
  };
}

const tempDirs: string[] = [];

async function createStore(): Promise<PrIndexStore> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawlens-"));
  tempDirs.push(tempDir);
  return new PrIndexStore({
    dbPath: path.join(tempDir, "index.sqlite"),
    embeddingModel: MISSING_MODEL,
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("PrIndexStore", () => {
  it("stores PRs, labels, comments, and supports exact and label search", async () => {
    const store = await createStore();
    const pr = makePullRequest(35983, {
      title: "Fix marker spoofing",
      body: "Closes the sanitizer bypass when security markers are spoofed.",
      labels: ["size: XS", "contributor"],
    });
    pr.comments.push(
      makeComment(
        "issue:1",
        "Repro: marker spoofing still bypasses sanitization on edited content.",
      ),
    );
    const source = new FakePullRequestDataSource([pr]);

    const summary = await store.sync({
      repo,
      source,
      full: true,
      hydrateAll: true,
    });
    expect(summary.mode).toBe("full");
    expect(summary.processedPrs).toBe(1);
    expect(summary.commentCount).toBe(1);
    expect(summary.docCount).toBe(2);
    expect(summary.labelCount).toBe(2);

    const status = await store.status();
    expect(status.prCount).toBe(1);
    expect(status.commentCount).toBe(1);
    expect(status.docCount).toBe(2);
    expect(status.vectorAvailable).toBe(summary.vectorAvailable);

    const exact = await store.search("#35983");
    expect(exact).toHaveLength(1);
    expect(exact[0]?.prNumber).toBe(35983);

    const byLabel = await store.search('label:"size: XS"');
    expect(byLabel).toHaveLength(1);
    expect(byLabel[0]?.labels).toContain("size: XS");

    const byText = await store.search("marker spoofing");
    expect(byText).toHaveLength(1);
    expect(byText[0]?.matchedExcerpt).toContain("spoofing");

    const shown = await store.show(35983);
    expect(shown.pr?.title).toBe("Fix marker spoofing");
    expect(shown.comments).toHaveLength(1);
    expect(shown.comments[0]?.excerpt).toContain("spoofing");
  });

  it("refreshes only changed PRs during incremental sync and overwrites labels", async () => {
    const store = await createStore();
    const first = makePullRequest(35983, {
      title: "Initial label state",
      body: "Tracks the original XS label.",
      labels: ["size: XS", "contributor"],
      updatedAt: "2026-03-10T00:00:00.000Z",
    });
    const second = makePullRequest(40001, {
      title: "Unchanged PR",
      body: "This PR should stay untouched during incremental sync.",
      labels: ["size: M"],
      updatedAt: "2026-03-10T00:00:00.000Z",
    });
    first.comments.push(makeComment("issue:xs", "Existing comment should stay cached."));
    const source = new FakePullRequestDataSource([first, second]);

    await store.sync({ repo, source, full: true, hydrateAll: true });
    source.hydrateCalls = [];

    const updated = makePullRequest(35983, {
      title: "Updated label state",
      body: "The PR moved out of XS and now tracks size S.",
      labels: ["size: S"],
      updatedAt: "2026-03-11T00:00:00.000Z",
    });
    source.setPullRequest(updated);
    source.changedPrs = [updated.pr];

    const summary = await store.sync({ repo, source });
    expect(summary.mode).toBe("incremental");
    expect(summary.processedPrs).toBe(1);
    expect(source.hydrateCalls).toEqual([]);

    const oldLabel = await store.search('label:"size: XS"');
    expect(oldLabel).toHaveLength(0);

    const newLabel = await store.search('label:"size: S"');
    expect(newLabel).toHaveLength(1);
    expect(newLabel[0]?.prNumber).toBe(35983);
    expect(newLabel[0]?.labels).toEqual(["size: S"]);

    const unchanged = await store.search("#40001");
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0]?.title).toBe("Unchanged PR");

    const shown = await store.show(35983);
    expect(shown.comments).toHaveLength(1);
    expect(shown.comments[0]?.excerpt).toContain("Existing comment");
  });

  it("uses shallow full sync by default to avoid hydrating every PR", async () => {
    const store = await createStore();
    const pr = makePullRequest(50001, {
      title: "Shallow full sync",
      body: "Only PR metadata should land during default full sync.",
      labels: ["size: XL", "contributor"],
    });
    pr.comments.push(
      makeComment("issue:2", "This comment should not be hydrated in shallow mode."),
    );
    const source = new FakePullRequestDataSource([pr]);

    const summary = await store.sync({ repo, source, full: true });
    expect(summary.processedPrs).toBe(1);
    expect(summary.commentCount).toBe(0);
    expect(source.hydrateCalls).toEqual([]);

    const result = await store.search('label:contributor "Shallow full sync"');
    expect(result).toHaveLength(1);
    expect(result[0]?.prNumber).toBe(50001);
  });

  it("does not initialize embeddings during status or shallow sync", async () => {
    const createProvider = vi
      .spyOn(embeddingModule, "createLocalEmbeddingProvider")
      .mockRejectedValue(new Error("embedding init should stay lazy"));
    const store = await createStore();
    const source = new FakePullRequestDataSource([makePullRequest(50002)]);

    await store.status();
    const summary = await store.sync({ repo, source, full: true });

    expect(summary.processedPrs).toBe(1);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("stores issues, supports issue search, and cross references issues to pull requests", async () => {
    const store = await createStore();
    const pr = makePullRequest(61001, {
      title: "Fix marker spoofing",
      body: "Spoofed markers bypass sanitization after edited content.",
      labels: ["size: XS"],
    });
    const issue = makeIssue(42001, {
      title: "Marker spoofing bypass in edited content",
      body: "Spoofed markers still bypass sanitization after users edit a message.",
      labels: ["bug", "size: XS"],
    });

    await store.sync({
      repo,
      source: new FakePullRequestDataSource([pr]),
      full: true,
    });
    const issueSummary = await store.syncIssues({
      repo,
      source: new FakeIssueDataSource([issue]),
      full: true,
    });

    expect(issueSummary.entity).toBe("issues");
    expect(issueSummary.processedIssues).toBe(1);

    const issueResults = await store.searchIssues('label:bug "marker spoofing"');
    expect(issueResults).toHaveLength(1);
    expect(issueResults[0]?.issueNumber).toBe(42001);

    const xrefIssue = await store.crossReferenceIssueToPullRequests(42001, 5);
    expect(xrefIssue.issue?.issueNumber).toBe(42001);
    expect(xrefIssue.pullRequests[0]?.prNumber).toBe(61001);

    const xrefPr = await store.crossReferencePullRequestToIssues(61001, 5);
    expect(xrefPr.pullRequest?.prNumber).toBe(61001);
    expect(xrefPr.issues[0]?.issueNumber).toBe(42001);

    const status = await store.status();
    expect(status.issueCount).toBe(1);
    expect(status.issueLabelCount).toBe(2);
  });

  it("refreshes changed issues incrementally without refetching each issue", async () => {
    const store = await createStore();
    const source = new FakeIssueDataSource([
      makeIssue(42001, {
        title: "Initial issue state",
        body: "Tracks the original body.",
        labels: ["bug"],
        updatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);

    await store.syncIssues({ repo, source, full: true });
    source.getIssueCalls = [];
    source.changedIssues = [
      makeIssue(42001, {
        title: "Updated issue state",
        body: "Tracks the updated issue body.",
        labels: ["bug", "needs-triage"],
        updatedAt: "2026-03-11T00:00:00.000Z",
      }),
    ];

    const summary = await store.syncIssues({ repo, source });
    expect(summary.mode).toBe("incremental");
    expect(summary.processedIssues).toBe(1);
    expect(source.getIssueCalls).toEqual([]);

    const results = await store.searchIssues('label:"needs-triage" updated');
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Updated issue state");
  });

  it("clusters linked-issue PRs by best base coverage and keeps merge readiness separate", async () => {
    const store = await createStore();
    const seed = makePullRequest(41793, {
      title: "fix: prune image-containing tool results during context pruning",
      body: "Source Issue #41789\nPrune image-containing tool results during context pruning.",
      updatedAt: "2026-03-09T00:00:00.000Z",
      labels: ["size: XS"],
    });
    const best = makePullRequest(42212, {
      title: "fix: prune image-containing tool results across context pruning paths",
      body: "Source Issue #41789\nHandle image-containing tool results in pruner and history image pruning paths.",
      updatedAt: "2026-03-10T00:00:00.000Z",
      labels: ["size: XS"],
    });
    const partial = makePullRequest(41863, {
      title: "fix: prune image-containing tool results in pruner",
      body: "Source Issue #41789\nHandle image-containing tool results in pruner only.",
      updatedAt: "2026-03-08T00:00:00.000Z",
      labels: ["size: XS"],
    });
    const excluded = makePullRequest(42946, {
      title: "fix: historical image-containing tool results in transcript replay",
      body: "Source Issue #42171\nHistorical image-containing tool results still affect context pruning during transcript replay.",
      updatedAt: "2026-03-11T00:00:00.000Z",
      labels: ["size: XS"],
    });

    await store.sync({
      repo,
      source: new FakePullRequestDataSource([seed, best, partial, excluded]),
      full: true,
    });

    await store.recordPullRequestFacts(
      makePullRequestFacts(41793, {
        headSha: "head-41793",
        linkedIssues: [{ issueNumber: 41789, linkSource: "source_issue_marker" }],
        changedFiles: [
          { path: "src/agents/pi-extensions/context-pruning/pruner.ts", kind: "prod" },
        ],
      }),
    );
    await store.recordPullRequestFacts(
      makePullRequestFacts(42212, {
        headSha: "ccbd07d3a",
        linkedIssues: [{ issueNumber: 41789, linkSource: "source_issue_marker" }],
        changedFiles: [
          { path: ".github/workflows/auto-response.yml", kind: "other" },
          { path: "src/agents/pi-extensions/context-pruning/pruner.ts", kind: "prod" },
          {
            path: "src/agents/pi-embedded-runner/run/history-image-prune.ts",
            kind: "prod",
          },
          {
            path: "src/agents/pi-extensions/context-pruning/pruner.test.ts",
            kind: "test",
          },
          {
            path: "src/agents/pi-embedded-runner/run/history-image-prune.test.ts",
            kind: "test",
          },
          { path: "docs/help/troubleshooting.md", kind: "other" },
        ],
      }),
    );
    await store.recordPullRequestFacts(
      makePullRequestFacts(41863, {
        headSha: "head-41863",
        linkedIssues: [{ issueNumber: 41789, linkSource: "source_issue_marker" }],
        changedFiles: [
          { path: "src/agents/pi-extensions/context-pruning/pruner.ts", kind: "prod" },
        ],
      }),
    );
    await store.recordPullRequestFacts(
      makePullRequestFacts(42946, {
        headSha: "head-42946",
        linkedIssues: [{ issueNumber: 42171, linkSource: "source_issue_marker" }],
        changedFiles: [
          {
            path: "src/agents/pi-embedded-runner/run/history-image-prune.ts",
            kind: "prod",
          },
          {
            path: "src/agents/pi-embedded-runner/run/history-image-prune.test.ts",
            kind: "test",
          },
        ],
      }),
    );
    await store.recordReviewFact(
      makeReviewFact(42212, {
        headSha: "ccbd07d3a",
        summary: "Existing integration-style contract test still fails.",
        commands: [
          "scripts/pr review-checkout-pr 42212",
          "scripts/pr review-tests 42212 src/agents/pi-extensions/context-pruning.test.ts",
        ],
        failingTests: [
          "src/agents/pi-extensions/context-pruning.test.ts > skips tool results that contain images (no soft trim, no hard clear)",
        ],
      }),
    );

    const analysis = await store.clusterPullRequest({
      prNumber: 41793,
      limit: 10,
      ftsOnly: true,
    });

    expect(analysis?.clusterBasis).toBe("linked_issue");
    expect(analysis?.clusterIssueNumbers).toEqual([41789]);
    expect(analysis?.bestBase?.prNumber).toBe(42212);
    expect(analysis?.bestBase?.status).toBe("best_base");
    expect(analysis?.bestBase?.matchedBy).toBe("linked_issue");
    expect(analysis?.bestBase?.relevantProdFiles).toEqual([
      "src/agents/pi-embedded-runner/run/history-image-prune.ts",
      "src/agents/pi-extensions/context-pruning/pruner.ts",
    ]);
    expect(analysis?.bestBase?.relevantTestFiles).toEqual([
      "src/agents/pi-embedded-runner/run/history-image-prune.test.ts",
      "src/agents/pi-extensions/context-pruning/pruner.test.ts",
    ]);
    expect(analysis?.bestBase?.noiseFilesCount).toBe(2);
    expect(analysis?.bestBase?.reason).toContain("broader relevant production coverage");
    expect(analysis?.bestBase?.reason).toContain("adds companion tests");
    expect(analysis?.mergeReadiness).toEqual({
      state: "needs_work",
      source: "review_fact",
      summary: "Existing integration-style contract test still fails.",
      commands: [
        "scripts/pr review-checkout-pr 42212",
        "scripts/pr review-tests 42212 src/agents/pi-extensions/context-pruning.test.ts",
      ],
      failingTests: [
        "src/agents/pi-extensions/context-pruning.test.ts > skips tool results that contain images (no soft trim, no hard clear)",
      ],
      headSha: "ccbd07d3a",
    });

    expect(analysis?.sameClusterCandidates.map((candidate) => candidate.prNumber)).toEqual([
      42212, 41793, 41863,
    ]);
    expect(analysis?.sameClusterCandidates[1]).toMatchObject({
      prNumber: 41793,
      status: "superseded_candidate",
      supersededBy: 42212,
    });
    expect(analysis?.sameClusterCandidates[1]?.relevantProdFiles).toEqual([
      "src/agents/pi-extensions/context-pruning/pruner.ts",
    ]);
    expect(analysis?.sameClusterCandidates[1]?.reason).toContain(
      "narrower relevant production coverage",
    );
    expect(analysis?.sameClusterCandidates[1]?.reason).toContain("fewer companion tests");
    expect(analysis?.sameClusterCandidates[2]).toMatchObject({
      prNumber: 41863,
      status: "superseded_candidate",
      supersededBy: 42212,
    });
    expect(analysis?.nearbyButExcluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          prNumber: 42946,
          matchedBy: "local_semantic",
          linkedIssues: [42171],
          excludedReasonCode: "different_linked_issue",
          reason: "different_linked_issue: #42171",
        }),
      ]),
    );
  });

  it("falls back to semantic-only candidates when exact issue links are absent", async () => {
    const store = await createStore();
    const seed = makePullRequest(34019, {
      title: "fix: detect ollama prompt too long as context overflow error",
      body: "Detect prompt too long failures as context overflow errors.",
      updatedAt: "2026-03-10T00:00:00.000Z",
    });
    const neighbor = makePullRequest(34020, {
      title: "fix: detect prompt too long failures as context overflow details",
      body: "Detect prompt too long failures as context overflow errors and show more details to the user.",
      updatedAt: "2026-03-11T00:00:00.000Z",
    });

    await store.sync({
      repo,
      source: new FakePullRequestDataSource([seed, neighbor]),
      full: true,
    });
    await store.recordPullRequestFacts(
      makePullRequestFacts(34019, {
        changedFiles: [{ path: "src/providers/ollama.ts", kind: "prod" }],
      }),
    );
    await store.recordPullRequestFacts(
      makePullRequestFacts(34020, {
        changedFiles: [{ path: "src/providers/ollama.ts", kind: "prod" }],
      }),
    );

    const analysis = await store.clusterPullRequest({
      prNumber: 34019,
      limit: 10,
      ftsOnly: true,
    });

    expect(analysis?.clusterBasis).toBe("semantic_only");
    expect(analysis?.clusterIssueNumbers).toEqual([]);
    expect(analysis?.bestBase).toBeNull();
    expect(analysis?.mergeReadiness).toBeNull();
    expect(analysis?.sameClusterCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          prNumber: 34020,
          matchedBy: "local_semantic",
          status: "possible_same_cluster",
          reason: "semantic-only candidate",
        }),
      ]),
    );
  });

  it("discovers same-issue siblings via live issue search and dedupes repeated failing checks", async () => {
    const store = await createStore();
    const seed = makePullRequest(34019, {
      title: 'fix: detect Ollama "prompt too long" as context overflow error',
      body: "Closes #34005\nDetect prompt too long failures as context overflow errors.",
      updatedAt: "2026-03-09T00:00:00.000Z",
    });
    const sibling = makePullRequest(36074, {
      title: "fix(agents): recognize Ollama context overflow error for auto-compaction",
      body: "Closes #34005\nRecognize Ollama context overflow and trigger auto-compaction.",
      updatedAt: "2026-03-10T00:00:00.000Z",
      state: "closed",
      closedAt: "2026-03-10T00:00:00.000Z",
    });
    const source = new FakePullRequestDataSource([seed, sibling]);
    source.setFacts(
      makePullRequestFacts(34019, {
        linkedIssues: [{ issueNumber: 34005, linkSource: "closing_reference" }],
        changedFiles: [
          { path: "src/agents/pi-embedded-helpers/errors.ts", kind: "prod" },
          {
            path: "src/agents/pi-embedded-helpers.formatassistanterrortext.test.ts",
            kind: "test",
          },
        ],
        statusChecks: [
          {
            name: "checks (bun, test, pnpm canvas:a2ui:bundle && bunx vitest run --config vitest.unit.config.ts)",
            status: "COMPLETED",
            conclusion: "FAILURE",
            workflowName: "CI",
            detailsUrl: null,
          },
          {
            name: "checks-windows (node, test, 3, 6, pnpm test)",
            status: "COMPLETED",
            conclusion: "FAILURE",
            workflowName: "CI",
            detailsUrl: null,
          },
          {
            name: "checks-windows (node, test, 3, 6, pnpm test)",
            status: "COMPLETED",
            conclusion: "FAILURE",
            workflowName: "CI",
            detailsUrl: null,
          },
        ],
      }),
    );
    source.setFacts(
      makePullRequestFacts(36074, {
        linkedIssues: [{ issueNumber: 34005, linkSource: "closing_reference" }],
        changedFiles: [{ path: "src/agents/pi-embedded-helpers/errors.ts", kind: "prod" }],
      }),
    );
    source.setSearchResults("34005", "closed", [36074]);

    await store.sync({
      repo,
      source: new FakePullRequestDataSource([seed]),
      full: true,
    });
    await store.recordPullRequestFacts(
      makePullRequestFacts(34019, {
        linkedIssues: [{ issueNumber: 34005, linkSource: "closing_reference" }],
        changedFiles: [
          { path: "src/agents/pi-embedded-helpers/errors.ts", kind: "prod" },
          {
            path: "src/agents/pi-embedded-helpers.formatassistanterrortext.test.ts",
            kind: "test",
          },
        ],
        statusChecks: [
          {
            name: "checks-windows (node, test, 3, 6, pnpm test)",
            status: "COMPLETED",
            conclusion: "FAILURE",
            workflowName: "CI",
            detailsUrl: null,
          },
          {
            name: "checks-windows (node, test, 3, 6, pnpm test)",
            status: "COMPLETED",
            conclusion: "FAILURE",
            workflowName: "CI",
            detailsUrl: null,
          },
        ],
      }),
    );

    const analysis = await store.clusterPullRequest({
      prNumber: 34019,
      limit: 10,
      ftsOnly: true,
      repo,
      source,
    });

    expect(analysis?.bestBase?.prNumber).toBe(34019);
    expect(analysis?.sameClusterCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          prNumber: 36074,
          matchedBy: "live_issue_search",
          status: "superseded_candidate",
          supersededBy: 34019,
        }),
      ]),
    );
    expect(analysis?.mergeReadiness).toMatchObject({
      state: "needs_work",
      source: "github",
      failingChecks: ["checks-windows (node, test, 3, 6, pnpm test) (x2)"],
    });
  });

  it("recovers semantic-only candidates via live search when local recall is empty", async () => {
    const store = await createStore();
    const seed = makePullRequest(39670, {
      title: "feat(agents): auto-show context usage warning when nearing token limit",
      body: "Auto-show a context usage warning before compaction issues become user-visible.",
      updatedAt: "2026-03-08T00:00:00.000Z",
    });
    const liveNeighbor = makePullRequest(39671, {
      title: "feat: show context usage warning before silent compaction",
      body: "Show a warning before silent compaction and token limit issues derail long sessions.",
      updatedAt: "2026-03-09T00:00:00.000Z",
    });
    const source = new FakePullRequestDataSource([seed, liveNeighbor]);
    source.setFacts(
      makePullRequestFacts(39671, {
        changedFiles: [{ path: "src/auto-reply/reply/agent-runner.ts", kind: "prod" }],
      }),
    );
    source.setSearchResults(
      "auto-show context usage warning when nearing token limit",
      "open",
      [39671],
    );

    await store.sync({
      repo,
      source: new FakePullRequestDataSource([seed]),
      full: true,
    });
    await store.recordPullRequestFacts(
      makePullRequestFacts(39670, {
        changedFiles: [{ path: "src/auto-reply/reply/agent-runner.ts", kind: "prod" }],
      }),
    );

    const analysis = await store.clusterPullRequest({
      prNumber: 39670,
      limit: 10,
      ftsOnly: true,
      repo,
      source,
    });

    expect(analysis?.clusterBasis).toBe("semantic_only");
    expect(analysis?.sameClusterCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          prNumber: 39671,
          matchedBy: "live_semantic",
          status: "possible_same_cluster",
        }),
      ]),
    );
  });

  it("prioritizes issue-linked hub PRs above recency-only PRs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));

    try {
      const store = await createStore();
      const recentOnly = makePullRequest(50010, {
        title: "chore: tidy recent copy updates",
        body: "Routine copy cleanup.",
        updatedAt: "2026-03-13T23:00:00.000Z",
      });
      const hub = makePullRequest(50011, {
        title: "fix: gateway timeout cascade across retry paths",
        body: "Closes #42001\nFix the gateway timeout cascade across retry paths.",
        updatedAt: "2026-03-13T12:00:00.000Z",
      });
      const sibling = makePullRequest(50012, {
        title: "fix: gateway timeout cascade in retry loop cleanup",
        body: "Closes #42001\nReduce retry loop fallout from the same gateway timeout cascade.",
        updatedAt: "2026-03-13T11:00:00.000Z",
      });

      await store.sync({
        repo,
        source: new FakePullRequestDataSource([recentOnly, hub, sibling]),
        full: true,
      });

      const queue = await store.listPriorityQueue({ repo, limit: 10, scanLimit: 10 });

      expect(queue[0]?.pr.prNumber).toBe(50011);
      expect(queue[0]?.linkedIssueCount).toBe(1);
      expect(queue[0]?.relatedPullRequestCount).toBeGreaterThan(0);
      expect(queue[0]?.reasons.map((reason) => reason.type)).toEqual(
        expect.arrayContaining(["freshness", "linked_issue", "related_pr", "hub_bonus"]),
      );
      expect(queue.find((candidate) => candidate.pr.prNumber === 50010)).toBeTruthy();
      expect(queue.find((candidate) => candidate.pr.prNumber === 50010)?.linkedIssueCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats maintainer as badge-only while watch and ignore stay local", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));

    try {
      const store = await createStore();
      const maintainerPr = makePullRequest(50020, {
        title: "refactor: normalize inbox score output",
        body: "Keep inbox score output stable.",
        updatedAt: "2026-03-13T08:00:00.000Z",
        labels: ["maintainer"],
      });
      const plainPr = makePullRequest(50021, {
        title: "refactor: normalize inbox score output",
        body: "Keep inbox score output stable.",
        updatedAt: "2026-03-13T08:00:00.000Z",
      });
      const ignoredPr = makePullRequest(50022, {
        title: "docs: refresh triage notes",
        body: "Routine docs cleanup.",
        updatedAt: "2026-03-13T08:00:00.000Z",
      });

      await store.sync({
        repo,
        source: new FakePullRequestDataSource([maintainerPr, plainPr, ignoredPr]),
        full: true,
      });

      let queue = await store.listPriorityQueue({ repo, limit: 10, scanLimit: 10 });
      const maintainerCandidate = queue.find((candidate) => candidate.pr.prNumber === 50020);
      const plainCandidate = queue.find((candidate) => candidate.pr.prNumber === 50021);

      expect(maintainerCandidate?.badges.maintainer).toBe(true);
      expect(plainCandidate?.badges.maintainer).toBe(false);
      expect(maintainerCandidate?.score).toBe(plainCandidate?.score);

      await store.setPrAttentionState(repo, 50021, "watch");
      await store.setPrAttentionState(repo, 50022, "ignore");

      queue = await store.listPriorityQueue({ repo, limit: 10, scanLimit: 10 });
      const watchedCandidate = queue.find((candidate) => candidate.pr.prNumber === 50021);

      expect(queue.some((candidate) => candidate.pr.prNumber === 50022)).toBe(false);
      expect(watchedCandidate?.attentionState).toBe("watch");
      expect(watchedCandidate?.reasons.map((reason) => reason.type)).toContain("watch");
      expect(watchedCandidate?.score).toBeGreaterThan(maintainerCandidate?.score ?? 0);

      const watchlist = await store.listWatchlist(repo, 10);
      expect(watchlist.map((candidate) => candidate.pr.prNumber)).toEqual([50021]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds a context bundle with linked issues, related PRs, cluster, and sparse extras", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));

    try {
      const store = await createStore();
      const seed = makePullRequest(50030, {
        title: "fix: compaction timeout spiral across retry paths",
        body: "Closes #42002\nFix the compaction timeout spiral across retry paths.",
        updatedAt: "2026-03-13T10:00:00.000Z",
      });
      seed.comments.push(
        makeComment("issue:50030", "Investigate retry and backoff interaction in compaction."),
      );
      const sibling = makePullRequest(50031, {
        title: "fix: compaction timeout spiral in retry loop handling",
        body: "Closes #42002\nReduce retry loop fallout from the same compaction timeout spiral.",
        updatedAt: "2026-03-13T09:00:00.000Z",
      });

      await store.sync({
        repo,
        source: new FakePullRequestDataSource([seed, sibling]),
        full: true,
        hydrateAll: true,
      });
      await store.syncIssues({
        repo,
        source: new FakeIssueDataSource([
          makeIssue(42002, {
            title: "Compaction timeout spiral",
            body: "Retry paths keep re-triggering compaction timeouts.",
          }),
        ]),
        full: true,
      });
      await store.recordPullRequestFacts(
        makePullRequestFacts(50030, {
          headSha: "head-50030",
          linkedIssues: [{ issueNumber: 42002, linkSource: "closing_reference" }],
          changedFiles: [{ path: "src/agents/compaction.ts", kind: "prod" }],
        }),
      );
      await store.recordPullRequestFacts(
        makePullRequestFacts(50031, {
          headSha: "head-50031",
          linkedIssues: [{ issueNumber: 42002, linkSource: "closing_reference" }],
          changedFiles: [{ path: "src/agents/compaction.ts", kind: "prod" }],
        }),
      );
      await store.recordReviewFact(
        makeReviewFact(50030, {
          summary: "Contract coverage still fails under retry-heavy runs.",
          commands: ["pnpm test -- compaction"],
          failingTests: ["compaction.test.ts > retries without timeout spiral"],
        }),
      );

      const bundle = await store.getPrContextBundle(repo, 50030);

      expect(bundle?.candidate.pr.prNumber).toBe(50030);
      expect(bundle?.linkedIssues.map((issue) => issue.issueNumber)).toEqual([42002]);
      expect(bundle?.relatedPullRequests).toEqual(
        expect.arrayContaining([expect.objectContaining({ prNumber: 50031 })]),
      );
      expect(bundle?.cluster?.clusterBasis).toBe("linked_issue");
      expect(bundle?.cluster?.sameClusterCandidates).toEqual(
        expect.arrayContaining([expect.objectContaining({ prNumber: 50031 })]),
      );
      expect(bundle?.comments[0]?.excerpt).toContain("retry and backoff");
      expect(bundle?.latestReviewFact?.summary).toContain("Contract coverage still fails");
      expect(bundle?.mergeReadiness).toMatchObject({
        source: "review_fact",
        state: "needs_work",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
