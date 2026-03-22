import { describe, expect, it } from "vitest";
import {
  mergeSummaryPullRequestRecord,
  selectPullRequestSyncWriteTarget,
} from "./pull-request-sync-contract.js";
import type { PullRequestRecord } from "../types.js";

function makePullRequest(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    number: 42,
    title: "PR 42",
    body: "Body",
    state: "open",
    isDraft: false,
    author: "frank",
    baseRef: "main",
    headRef: "feature/original",
    url: "https://example.test/pull/42",
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    labels: [],
    ...overrides,
  };
}

describe("pull request sync contract", () => {
  it("uses authoritative summaries during full sync unless hydrate-all is enabled", () => {
    expect(
      selectPullRequestSyncWriteTarget({
        pr: makePullRequest(),
        mode: "full",
        hydrateAll: false,
        storedUpdatedAt: null,
      }),
    ).toEqual({
      kind: "summary",
      authority: "authoritative",
      pr: makePullRequest(),
    });
    expect(
      selectPullRequestSyncWriteTarget({
        pr: makePullRequest(),
        mode: "full",
        hydrateAll: true,
        storedUpdatedAt: null,
      }),
    ).toEqual({
      kind: "hydrate",
      prNumber: 42,
    });
  });

  it("hydrates first-seen or incomplete incremental summaries", () => {
    expect(
      selectPullRequestSyncWriteTarget({
        pr: makePullRequest(),
        mode: "incremental",
        storedUpdatedAt: null,
      }),
    ).toEqual({
      kind: "hydrate",
      prNumber: 42,
    });
    expect(
      selectPullRequestSyncWriteTarget({
        pr: makePullRequest({ baseRef: "", headRef: "" }),
        mode: "incremental",
        storedUpdatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ).toEqual({
      kind: "hydrate",
      prNumber: 42,
    });
    expect(
      selectPullRequestSyncWriteTarget({
        pr: makePullRequest({ state: "closed", closedAt: "2026-03-11T00:00:00.000Z" }),
        mode: "incremental",
        storedUpdatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ).toEqual({
      kind: "hydrate",
      prNumber: 42,
    });
  });

  it("keeps incremental summaries partial when authoritative fields are present", () => {
    expect(
      selectPullRequestSyncWriteTarget({
        pr: makePullRequest(),
        mode: "incremental",
        storedUpdatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ).toEqual({
      kind: "summary",
      authority: "partial",
      pr: makePullRequest(),
    });
  });

  it("preserves existing metadata for partial summaries", () => {
    const merged = mergeSummaryPullRequestRecord({
      pr: makePullRequest({
        state: "closed",
        isDraft: false,
        baseRef: "",
        headRef: "",
        mergedAt: null,
      }),
      authority: "partial",
      existing: {
        state: "merged",
        isDraft: true,
        baseRef: "release",
        headRef: "feature/retargeted",
        url: "https://example.test/pull/42",
        closedAt: "2026-03-10T00:00:00.000Z",
        mergedAt: "2026-03-10T00:00:00.000Z",
      },
    });

    expect(merged.state).toBe("merged");
    expect(merged.isDraft).toBe(true);
    expect(merged.baseRef).toBe("release");
    expect(merged.headRef).toBe("feature/retargeted");
    expect(merged.mergedAt).toBe("2026-03-10T00:00:00.000Z");
  });

  it("lets authoritative summaries refresh draft and branch metadata", () => {
    const merged = mergeSummaryPullRequestRecord({
      pr: makePullRequest({
        isDraft: true,
        baseRef: "release",
        headRef: "feature/refreshed",
      }),
      authority: "authoritative",
      existing: {
        state: "open",
        isDraft: false,
        baseRef: "main",
        headRef: "feature/original",
        url: "https://example.test/pull/42",
        closedAt: null,
        mergedAt: null,
      },
    });

    expect(merged.isDraft).toBe(true);
    expect(merged.baseRef).toBe("release");
    expect(merged.headRef).toBe("feature/refreshed");
  });
});
