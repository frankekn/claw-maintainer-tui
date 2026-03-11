import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  benchmarkSemanticDataset,
  bootstrapSemanticDataset,
  previewNextSemanticReview,
  recordSemanticReview,
} from "./semantic.js";
import { PrIndexStore } from "./store.js";
import type {
  HydratedPullRequest,
  PullRequestCommentRecord,
  PullRequestDataSource,
  PullRequestRecord,
  RepoRef,
} from "./types.js";

const repo: RepoRef = { owner: "openclaw", name: "openclaw" };
const MISSING_MODEL = "/tmp/clawlens-missing-model.gguf";
const tempDirs: string[] = [];

class FakePullRequestDataSource implements PullRequestDataSource {
  private readonly hydrated = new Map<number, HydratedPullRequest>();

  constructor(items: HydratedPullRequest[]) {
    for (const item of items) {
      this.hydrated.set(item.pr.number, item);
    }
  }

  async *listAllPullRequests(): AsyncGenerator<PullRequestRecord> {
    for (const item of Array.from(this.hydrated.values()).sort(
      (a, b) => a.pr.number - b.pr.number,
    )) {
      yield item.pr;
    }
  }

  async listChangedPullRequestNumbersSince(): Promise<number[]> {
    return [];
  }

  async hydratePullRequest(_repo: RepoRef, prNumber: number): Promise<HydratedPullRequest> {
    const item = this.hydrated.get(prNumber);
    if (!item) {
      throw new Error(`missing PR ${prNumber}`);
    }
    return item;
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

  return { pr, comments: [] };
}

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

async function createStore(): Promise<PrIndexStore> {
  const tempDir = await createTempDir("clawlens-semantic-");
  return new PrIndexStore({
    dbPath: path.join(tempDir, "index.sqlite"),
    embeddingModel: MISSING_MODEL,
  });
}

async function readQueryRecords(datasetDir: string, split: "dev" | "holdout") {
  const file = path.join(datasetDir, `queries.${split}.jsonl`);
  const content = await readFile(file, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          queryId: string;
          split: "dev" | "holdout";
          clusterKey: string;
          query: string;
        },
    );
}

async function findQuerySplit(datasetDir: string, queryId: string): Promise<"dev" | "holdout"> {
  for (const split of ["dev", "holdout"] as const) {
    const records = await readQueryRecords(datasetDir, split);
    if (records.some((record) => record.queryId === queryId)) {
      return split;
    }
  }
  throw new Error(`query ${queryId} not found`);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("semantic dataset workflow", () => {
  it("bootstraps deterministic queries and keeps title clusters on one split", async () => {
    const store = await createStore();
    const prOne = makePullRequest(101, {
      title: "Fix login timeout after reconnect",
      body: "Users lose their session after reconnect because stale timeout tokens are reused.",
      labels: ["size: XS"],
    });
    prOne.comments.push(
      makeComment("comment:101", "Repro: reconnecting drops the session and forces another login."),
    );
    const prTwo = makePullRequest(102, {
      title: "Fix login timeout after reconnect on mobile",
      body: "Mobile reconnect still expires valid sessions after a gateway reconnect.",
      labels: ["size: XS"],
    });
    prTwo.comments.push(
      makeComment(
        "comment:102",
        "Regression: reconnect on mobile kicks users back to the sign in screen.",
      ),
    );
    const prThree = makePullRequest(103, {
      title: "Add export retry button",
      body: "Admins need a quick way to retry exports that were rate limited.",
      labels: ["contributor"],
    });
    const source = new FakePullRequestDataSource([prOne, prTwo, prThree]);
    await store.sync({ repo, source, full: true, hydrateAll: true });

    const datasetDir = await createTempDir("clawlens-semantic-dataset-");
    const summary = await bootstrapSemanticDataset({
      store,
      datasetPath: datasetDir,
      seed: 7,
    });

    expect(summary.queryCount).toBe(3);
    expect(summary.judgmentCount).toBeGreaterThanOrEqual(3);

    const devQueries = await readQueryRecords(datasetDir, "dev");
    const holdoutQueries = await readQueryRecords(datasetDir, "holdout");
    const allQueries = [...devQueries, ...holdoutQueries];
    const loginQueries = allQueries.filter((query) => query.clusterKey.includes("login-timeout"));
    expect(loginQueries.length).toBe(2);
    expect(new Set(loginQueries.map((query) => query.split)).size).toBe(1);
  });

  it("records reviewed judgments and surfaces the next pending query", async () => {
    const store = await createStore();
    const pr = makePullRequest(201, {
      title: "Fix marker spoofing",
      body: "Spoofed markers still bypass sanitization in edited content.",
      labels: ["size: XS"],
    });
    pr.comments.push(
      makeComment(
        "comment:201",
        "Repro: edited content with spoofed markers still bypasses sanitization.",
      ),
    );
    const source = new FakePullRequestDataSource([pr]);
    await store.sync({ repo, source, full: true, hydrateAll: true });

    const datasetDir = await createTempDir("clawlens-semantic-review-");
    await bootstrapSemanticDataset({ store, datasetPath: datasetDir, seed: 3 });
    const split = await findQuerySplit(datasetDir, "q:201");
    const preview = await previewNextSemanticReview({
      store,
      datasetPath: datasetDir,
      split,
    });
    expect(preview?.query.queryId).toBe("q:201");

    await recordSemanticReview({
      datasetPath: datasetDir,
      split,
      queryId: "q:201",
      primaryPrNumber: 201,
      related: [],
      note: "confirmed primary target",
    });

    const after = await previewNextSemanticReview({
      store,
      datasetPath: datasetDir,
      split,
    });
    expect(after).toBeNull();
  });

  it("benchmarks reviewed queries with graded judgments", async () => {
    const store = await createStore();
    const primary = makePullRequest(301, {
      title: "Fix marker spoofing",
      body: "Spoofed markers bypass sanitization after edits.",
      labels: ["size: XS"],
    });
    primary.comments.push(
      makeComment("comment:301", "Edited content with spoofed markers bypasses sanitization."),
    );
    const related = makePullRequest(302, {
      title: "Harden marker sanitization fallback",
      body: "Adds another sanitization guard for malformed markers.",
      labels: ["size: XS"],
    });
    const source = new FakePullRequestDataSource([primary, related]);
    await store.sync({ repo, source, full: true, hydrateAll: true });

    const datasetDir = await createTempDir("clawlens-semantic-benchmark-");
    await bootstrapSemanticDataset({ store, datasetPath: datasetDir, seed: 11 });
    const split = await findQuerySplit(datasetDir, "q:301");
    await recordSemanticReview({
      datasetPath: datasetDir,
      split,
      queryId: "q:301",
      primaryPrNumber: 301,
      related: [{ prNumber: 302, grade: 2 }],
    });

    const report = await benchmarkSemanticDataset({
      store,
      datasetPath: datasetDir,
      split: "all",
      limit: 10,
      mode: "fts",
    });

    expect(report.overall.queryCount).toBeGreaterThanOrEqual(1);
    expect(report.overall.mrr).toBeGreaterThan(0);
    expect(report.overall.ndcgAt5).toBeGreaterThan(0);
  });

  it("filters meta review bullets out of bootstrap queries", async () => {
    const store = await createStore();
    const pr = makePullRequest(401, {
      title: "Fix wildcard origin matching",
      body: [
        "- What did NOT change (scope boundary): keep existing allowlist behavior unchanged",
        "- Why it matters: reviewer discussion asked for a lower-risk patch",
        "Wildcard origins were treated as literal strings and never matched control UI requests.",
      ].join("\n"),
      labels: ["size: XS"],
    });
    const source = new FakePullRequestDataSource([pr]);
    await store.sync({ repo, source, full: true, hydrateAll: true });

    const datasetDir = await createTempDir("openclaw-semantic-filter-");
    await bootstrapSemanticDataset({ store, datasetPath: datasetDir, seed: 13 });
    const split = await findQuerySplit(datasetDir, "q:401");
    const queries = await readQueryRecords(datasetDir, split);
    const query = queries.find((item) => item.queryId === "q:401");

    expect(query).toBeTruthy();
    expect(query?.query).not.toContain("What did NOT change");
    expect(query?.query).not.toContain("Why it matters");
  });

  it("filters code-heavy path snippets out of bootstrap queries", async () => {
    const store = await createStore();
    const pr = makePullRequest(402, {
      title: "Fix provider prefix duplication",
      body: [
        "src/agents/model-selection openclaw/workspace/tmp-openclaw test src/agents/model-selection",
        "Non-OpenRouter providers duplicated the provider prefix in model refs.",
      ].join("\n"),
      labels: ["size: M"],
    });
    const source = new FakePullRequestDataSource([pr]);
    await store.sync({ repo, source, full: true, hydrateAll: true });

    const datasetDir = await createTempDir("clawlens-semantic-codeheavy-");
    await bootstrapSemanticDataset({ store, datasetPath: datasetDir, seed: 17 });
    const split = await findQuerySplit(datasetDir, "q:402");
    const queries = await readQueryRecords(datasetDir, split);
    const query = queries.find((item) => item.queryId === "q:402");

    expect(query).toBeTruthy();
    expect(query?.query).not.toContain("src/agents");
    expect(query?.query).toContain("providers duplicated");
  });

  it("supports comment-only bootstrap datasets", async () => {
    const store = await createStore();
    const pr = makePullRequest(500, {
      title: "Fix marker spoofing",
      body: "Spoofed markers still bypass sanitization in edited content.",
      labels: ["size: XS"],
    });
    pr.comments.push(
      makeComment(
        "comment:500",
        "Edited content with spoofed markers still bypasses sanitization after another edit and leaks the raw marker output back to the user.",
      ),
    );
    const source = new FakePullRequestDataSource([pr]);
    await store.sync({ repo, source, full: true, hydrateAll: true });

    const datasetDir = await createTempDir("clawlens-semantic-comment-only-");
    const summary = await bootstrapSemanticDataset({
      store,
      datasetPath: datasetDir,
      seed: 19,
      sourceKinds: ["comment"],
    });
    expect(summary.queryCount).toBe(1);
    const devContent = await readFile(path.join(datasetDir, "queries.dev.jsonl"), "utf8");
    const holdoutContent = await readFile(path.join(datasetDir, "queries.holdout.jsonl"), "utf8");
    const records = `${devContent}\n${holdoutContent}`
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sourceKind?: string; query?: string });

    expect(records).toHaveLength(1);
    expect(records[0]?.sourceKind).toBe("comment");
    expect(records[0]?.query).toContain("spoofed markers");
  });
});
