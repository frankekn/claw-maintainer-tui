import { describe, expect, it, vi } from "vitest";
import {
  GhCliPullRequestDataSource,
  ghCommandJsonWithRetry,
  ghApiJsonWithRetry,
  isRetryableGhApiError,
  normalizePullRequestFactRecord,
  type GhJsonFetcher,
} from "./github.js";
import { collectLinkedIssuesFromPrText } from "./lib/pull-request-facts.js";
import type { IssueRecord, RepoRef } from "./types.js";

const repo: RepoRef = { owner: "openclaw", name: "openclaw" };

type TestIssueRow = {
  number: number;
  title?: string | null;
  body?: string | null;
  state?: "open" | "closed" | null;
  user?: { login?: string | null } | null;
  html_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  labels?: Array<{ name?: string | null }> | null;
  pull_request?: Record<string, unknown> | null;
};

describe("clawlens github retry", () => {
  it("retries transient gh api failures before succeeding", async () => {
    const runner = vi
      .fn<(_: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("read tcp 1.2.3.4:443: read: connection reset by peer"))
      .mockRejectedValueOnce(new Error("HTTP 503 Service Unavailable"))
      .mockResolvedValue('{"ok":true,"count":2}');
    const sleepFn = vi.fn<(_: number) => Promise<void>>().mockResolvedValue();

    const result = await ghApiJsonWithRetry<{ ok: boolean; count: number }>("repos/x/y/pulls", {
      runner,
      attempts: 4,
      backoffMs: 25,
      sleepFn,
    });

    expect(result).toEqual({ ok: true, count: 2 });
    expect(runner).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 25);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 50);
  });

  it("does not retry non-transient gh api failures", async () => {
    const runner = vi
      .fn<(_: string) => Promise<string>>()
      .mockRejectedValue(new Error("HTTP 404 Not Found"));
    const sleepFn = vi.fn<(_: number) => Promise<void>>().mockResolvedValue();

    await expect(
      ghApiJsonWithRetry("repos/x/y/pulls", {
        runner,
        attempts: 4,
        sleepFn,
      }),
    ).rejects.toThrow("HTTP 404 Not Found");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("retries transient gh command failures before succeeding", async () => {
    const runner = vi
      .fn<(_: string[]) => Promise<string>>()
      .mockRejectedValueOnce(new Error("HTTP 429 Too Many Requests"))
      .mockResolvedValue('[{"number":42}]');
    const sleepFn = vi.fn<(_: number) => Promise<void>>().mockResolvedValue();

    const result = await ghCommandJsonWithRetry<Array<{ number: number }>>(
      ["search", "prs", "query", "--json", "number"],
      {
        runner,
        attempts: 3,
        backoffMs: 10,
        sleepFn,
      },
    );

    expect(result).toEqual([{ number: 42 }]);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(10);
  });

  it("recognizes retryable transport and rate-limit errors", () => {
    expect(isRetryableGhApiError(new Error("connection reset by peer"))).toBe(true);
    expect(isRetryableGhApiError(new Error("read: can't assign requested address"))).toBe(true);
    expect(isRetryableGhApiError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isRetryableGhApiError(new Error("HTTP 503 Service Unavailable"))).toBe(true);
    expect(isRetryableGhApiError(new Error("HTTP 404 Not Found"))).toBe(false);
  });

  it("collects all issue refs from closing-reference lists", () => {
    expect(
      collectLinkedIssuesFromPrText(
        "",
        "Fixes #12, #34 and #56\nSource Issue #78\n[issue #90]",
      ).map((issue) => issue.issueNumber),
    ).toEqual([12, 34, 56, 78]);
  });

  it("counts full issue slice limits after excluding pull request rows", async () => {
    const firstPage: TestIssueRow[] = [
      ...Array.from({ length: 99 }, (_, index) => ({
        number: index + 1,
        title: `PR row ${index + 1}`,
        pull_request: {},
      })),
      { number: 200, title: "First issue" },
    ];
    const secondPage: TestIssueRow[] = [
      { number: 201, title: "Second PR row", pull_request: {} },
      { number: 4, title: "Second issue" },
      { number: 5, title: "Third issue" },
    ];
    const paths: string[] = [];
    const fetchJson: GhJsonFetcher = async <T>(path: string): Promise<T> => {
      paths.push(path);
      if (path.endsWith("page=1")) {
        return firstPage as T;
      }
      if (path.endsWith("page=2")) {
        return secondPage as T;
      }
      return [] as T;
    };
    const source = new GhCliPullRequestDataSource({ fetchJson });

    const issues: IssueRecord[] = [];
    for await (const issue of source.listAllIssues(repo, { limit: 2, newestFirst: true })) {
      issues.push(issue);
    }

    expect(issues.map((issue) => issue.number)).toEqual([200, 4]);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain("direction=desc");
    expect(paths[1]).toContain("page=2");
  });

  it("keeps pull request facts scoped to fact-owned closing references", () => {
    const facts = normalizePullRequestFactRecord({
      number: 42,
      title: "Fixes #12",
      body: "Source Issue #78\nFixes #12",
      closingIssuesReferences: [{ number: 12 }, { number: 34 }],
      files: [],
      statusCheckRollup: [],
    });

    expect(facts.linkedIssues).toEqual([
      { issueNumber: 12, linkSource: "closing_reference" },
      { issueNumber: 34, linkSource: "closing_reference" },
    ]);
  });
});
