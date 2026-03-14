import { describe, expect, it } from "vitest";
import {
  buildStatusRows,
  defaultSecondaryHintText,
  formatHeader,
  formatInboxLandingDetail,
  formatListSummary,
  formatModeTabs,
  formatPriorityPrDetail,
  formatResultRow,
  formatStatusDetail,
} from "./format.js";
import type { PrContextBundle, PriorityCandidate, StatusSnapshot } from "../types.js";
import type { TuiHeaderModel } from "./types.js";

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

const headerModel: TuiHeaderModel = {
  repo: "openclaw/openclaw",
  dbPath: "/tmp/clawlens.sqlite",
  activeModeLabel: "Inbox",
  ftsOnly: false,
  status,
  rateLimit: {
    limit: 5000,
    remaining: 0,
    resetAt: "2026-03-11T09:17:43.000Z",
  },
  syncMode: null,
  syncJobs: [
    {
      entity: "prs",
      state: "running",
      progress: {
        entity: "prs",
        phase: "syncing",
        processed: 12,
        skipped: 3,
        queued: 9,
        totalKnown: null,
        currentId: 42531,
        currentTitle: "PR 42531",
      },
      errorMessage: null,
      pendingRerun: false,
      nextAutoUpdateAt: null,
      lastCompletedAt: null,
    },
  ],
  detailAutoRefreshInFlight: true,
  busyMessage: null,
  errorMessage: null,
};

function makeCandidate(): PriorityCandidate {
  return {
    pr: {
      prNumber: 41793,
      title: "prune image-containing tool results",
      url: "https://github.com/openclaw/openclaw/pull/41793",
      state: "open",
      author: "frank",
      labels: ["maintainer"],
      updatedAt: "2026-03-11T08:00:00.000Z",
      score: 54,
      matchedDocKind: "pr_body",
      matchedExcerpt: "Matched excerpt for the priority candidate.",
    },
    attentionState: "watch",
    score: 54,
    reasons: [
      { type: "watch", label: "watchlist pin", points: 30 },
      { type: "linked_issue", label: "links 2 issues", points: 16 },
      { type: "hub_bonus", label: "connects issues and related PR work", points: 8 },
    ],
    linkedIssueCount: 2,
    relatedPullRequestCount: 3,
    badges: {
      draft: false,
      maintainer: true,
    },
  };
}

function makeBundle(): PrContextBundle {
  const candidate = makeCandidate();
  return {
    candidate,
    comments: [
      {
        kind: "issue_comment",
        author: "reviewer",
        createdAt: "2026-03-12T00:00:00.000Z",
        url: "https://github.com/openclaw/openclaw/pull/41793#comment",
        excerpt: "Comment excerpt",
      },
    ],
    linkedIssues: [
      {
        issueNumber: 41789,
        title: "Issue 41789",
        url: "https://github.com/openclaw/openclaw/issues/41789",
        state: "open",
        author: "frank",
        labels: [],
        updatedAt: "2026-03-12T00:00:00.000Z",
        score: 1,
        matchedExcerpt: "Issue excerpt",
      },
    ],
    relatedPullRequests: [
      {
        prNumber: 42212,
        title: "fix: prune image-containing tool results",
        url: "https://github.com/openclaw/openclaw/pull/42212",
        state: "open",
        author: "frank",
        labels: [],
        updatedAt: "2026-03-12T00:00:00.000Z",
        score: 0.91,
        matchedDocKind: "pr_body",
        matchedExcerpt: "Related PR excerpt",
      },
    ],
    cluster: {
      seedPr: {
        prNumber: 41793,
        title: "prune image-containing tool results",
        url: "https://github.com/openclaw/openclaw/pull/41793",
        state: "open",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
      clusterBasis: "linked_issue",
      clusterIssueNumbers: [41789],
      bestBase: null,
      sameClusterCandidates: [],
      nearbyButExcluded: [],
      mergeReadiness: null,
    },
    latestReviewFact: null,
    mergeReadiness: null,
  };
}

describe("tui formatting", () => {
  it("formats the header with sync badges", () => {
    const header = formatHeader(headerModel, new Date("2026-03-11T08:28:13.832Z"));

    expect(header).toContain("MODE Inbox");
    expect(header).toContain("REPO openclaw/openclaw");
    expect(header).toContain("PR 1h");
    expect(header).toContain("ISSUE 44m");
    expect(header).toContain("QUOTA 0/5000");
    expect(header).toContain("PR SYNC 12+3");
    expect(header).toContain("DETAIL REFRESHING");
  });

  it("formats priority rows and detail sections", () => {
    const candidate = makeCandidate();
    const row = formatResultRow(
      {
        kind: "pr",
        pr: candidate.pr,
        freshness: "fresh",
        priority: candidate,
      },
      "inbox",
    );
    expect(row).toContain("WATCH");
    expect(row).toContain("I2 R3");

    const detail = formatPriorityPrDetail(makeBundle(), "linked-issues");
    expect(detail.text).toContain("WHY PRIORITIZED");
    expect(detail.text).toContain("LINKED ISSUES");
    expect(detail.text).toContain("MAINTAINER STATE");
    expect(detail.anchorLine).not.toBeNull();
  });

  it("formats Inbox landing copy and mode tabs", () => {
    const detail = formatInboxLandingDetail(status, new Date("2026-03-11T08:28:13.832Z"));

    expect(detail).toContain("START HERE");
    expect(detail).toContain("single priority queue");
    expect(detail).toContain("v / w / i / u");

    const tabs = formatModeTabs("inbox", "nav");
    expect(tabs).toContain("Inbox");
    expect(tabs).toContain("Watchlist");
    expect(tabs).toContain("Explore");
  });

  it("formats status detail, status rows, summaries, and hints", () => {
    const detail = formatStatusDetail(status, new Date("2026-03-11T08:28:13.832Z"));
    expect(detail).toContain("INDEX");
    expect(detail).toContain("vector");
    expect(detail).toContain("ready");

    expect(buildStatusRows(status)).toEqual([
      { kind: "status", label: "{#9fb0c4-fg}PRs{/}", value: "{#4fd1a1-fg}23935{/}" },
      { kind: "status", label: "{#9fb0c4-fg}Issues{/}", value: "{#4fd1a1-fg}17535{/}" },
      { kind: "status", label: "{#9fb0c4-fg}Comments{/}", value: "{#e7edf5-fg}100{/}" },
      { kind: "status", label: "{#9fb0c4-fg}Docs{/}", value: "{#e7edf5-fg}24035{/}" },
      { kind: "status", label: "{#9fb0c4-fg}Vector{/}", value: "{#4fd1a1-fg}ready{/}" },
    ]);

    expect(
      formatListSummary({
        yieldLabel: "20 PRs",
        confidenceLabel: "issue-linked 8 · related 5",
        coverageLabel: "priority queue",
      }),
    ).toContain("priority queue");
    expect(defaultSecondaryHintText("inbox", true)).toContain("v/w/i/u");
    expect(defaultSecondaryHintText("pr-search", true)).toContain("/");
  });
});
