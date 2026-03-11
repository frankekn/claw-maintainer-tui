import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrIndexStore } from "./store.js";
import type {
  HydratedPullRequest,
  IssueDataSource,
  IssueRecord,
  PullRequestCommentRecord,
  PullRequestDataSource,
  PullRequestRecord,
  RepoRef,
} from "./types.js";

const repo: RepoRef = { owner: "openclaw", name: "openclaw" };
const MISSING_MODEL = "/tmp/clawlens-missing-model.gguf";

class FakePullRequestDataSource implements PullRequestDataSource {
  private readonly hydrated = new Map<number, HydratedPullRequest>();
  changedPrNumbers: number[] = [];
  hydrateCalls: number[] = [];

  constructor(items: HydratedPullRequest[]) {
    for (const item of items) {
      this.hydrated.set(item.pr.number, item);
    }
  }

  setPullRequest(item: HydratedPullRequest): void {
    this.hydrated.set(item.pr.number, item);
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

  async hydratePullRequest(_repo: RepoRef, prNumber: number): Promise<HydratedPullRequest> {
    this.hydrateCalls.push(prNumber);
    const payload = this.hydrated.get(prNumber);
    if (!payload) {
      throw new Error(`missing PR ${prNumber}`);
    }
    return payload;
  }
}

class FakeIssueDataSource implements IssueDataSource {
  private readonly issues = new Map<number, IssueRecord>();
  changedIssueNumbers: number[] = [];

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

  async getIssue(_repo: RepoRef, issueNumber: number): Promise<IssueRecord> {
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
    expect(summary.vectorAvailable).toBe(false);

    const status = await store.status();
    expect(status.prCount).toBe(1);
    expect(status.commentCount).toBe(1);
    expect(status.docCount).toBe(2);
    expect(status.vectorAvailable).toBe(false);

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
    const source = new FakePullRequestDataSource([first, second]);

    await store.sync({ repo, source, full: true });
    source.hydrateCalls = [];

    source.setPullRequest(
      makePullRequest(35983, {
        title: "Updated label state",
        body: "The PR moved out of XS and now tracks size S.",
        labels: ["size: S"],
        updatedAt: "2026-03-11T00:00:00.000Z",
      }),
    );
    source.changedPrNumbers = [35983];

    const summary = await store.sync({ repo, source });
    expect(summary.mode).toBe("incremental");
    expect(summary.processedPrs).toBe(1);
    expect(source.hydrateCalls).toEqual([35983]);

    const oldLabel = await store.search('label:"size: XS"');
    expect(oldLabel).toHaveLength(0);

    const newLabel = await store.search('label:"size: S"');
    expect(newLabel).toHaveLength(1);
    expect(newLabel[0]?.prNumber).toBe(35983);
    expect(newLabel[0]?.labels).toEqual(["size: S"]);

    const unchanged = await store.search("#40001");
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0]?.title).toBe("Unchanged PR");
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
});
