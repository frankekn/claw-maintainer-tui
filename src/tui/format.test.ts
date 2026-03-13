import { describe, expect, it } from "vitest";
import {
  buildStatusRows,
  formatActionBar,
  formatClusterDetail,
  formatCrossSearchLandingDetail,
  formatHeader,
  formatListSummary,
  formatModeTabs,
  formatResultRow,
  formatStatusDetail,
} from "./format.js";
import type { ClusterCandidate, StatusSnapshot } from "../types.js";
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
  activeModeLabel: "Cross Search",
  ftsOnly: false,
  status,
  rateLimit: {
    limit: 5000,
    remaining: 0,
    resetAt: "2026-03-11T09:17:43.000Z",
  },
  syncMode: "metadata",
  detailAutoRefreshInFlight: true,
  busyMessage: null,
  errorMessage: null,
};

describe("tui formatting", () => {
  it("formats a dense header with mode sync quota and detail refresh badges", () => {
    const header = formatHeader(headerModel, new Date("2026-03-11T08:28:13.832Z"));

    expect(header).toContain("MODE Cross Search");
    expect(header).toContain("REPO openclaw/openclaw");
    expect(header).toContain("PR 1h");
    expect(header).toContain("ISSUE 44m");
    expect(header).toContain("QUOTA 0/5000");
    expect(header).toContain("FAST SYNC");
    expect(header).toContain("DETAIL REFRESHING");
    expect(header).toContain("{#63c8ff-bg}");
  });

  it("formats status detail and status rows from the repository snapshot", () => {
    const detail = formatStatusDetail(status, new Date("2026-03-11T08:28:13.832Z"));
    expect(detail).toContain("INDEX");
    expect(detail).toContain("prs");
    expect(detail).toContain("23935");
    expect(detail).toContain("vector");
    expect(detail).toContain("ready");

    expect(buildStatusRows(status)).toEqual([
      { kind: "status", label: "{#9fb0c4-fg}PRs{/}", value: "{#4fd1a1-fg}23935{/}" },
      { kind: "status", label: "{#9fb0c4-fg}Issues{/}", value: "{#4fd1a1-fg}17535{/}" },
      { kind: "status", label: "{#9fb0c4-fg}Comments{/}", value: "{#e7edf5-fg}100{/}" },
      { kind: "status", label: "{#9fb0c4-fg}Docs{/}", value: "{#e7edf5-fg}24035{/}" },
      { kind: "status", label: "{#9fb0c4-fg}Vector{/}", value: "{#4fd1a1-fg}ready{/}" },
    ]);
  });

  it("formats cluster rows and detail with verification coverage", () => {
    const candidate: ClusterCandidate = {
      prNumber: 42212,
      title: "fix: prune image-containing tool results across context pruning paths",
      url: "https://github.com/openclaw/openclaw/pull/42212",
      state: "open",
      updatedAt: "2026-03-10T00:00:00.000Z",
      headSha: "head-42212",
      matchedBy: "linked_issue",
      linkedIssues: [41789],
      prodFiles: ["a.ts", "b.ts"],
      testFiles: ["a.test.ts", "b.test.ts"],
      otherFiles: ["README.md"],
      relevantProdFiles: ["a.ts", "b.ts"],
      relevantTestFiles: ["a.test.ts"],
      noiseFilesCount: 1,
      status: "best_base",
      reasonCodes: ["broader_relevant_prod_coverage"],
      reason: "broader relevant production coverage",
    };

    expect(
      formatResultRow({
        kind: "cluster-candidate",
        candidate,
        verification: "done",
      }),
    ).toContain("VERIFIED");
    expect(
      formatClusterDetail(
        {
          seedLabel: "seed_pr: #41793 prune image-containing tool results",
          clusterBasis: "linked_issue",
          clusterIssues: [41789],
          verificationSummary: "done · PR 2 · issue 1 · missing 0",
          mergeSummary: "needs_work via review_fact",
        },
        candidate,
      ),
    ).toContain("verification");
  });

  it("formats cross-search landing copy and mode tabs", () => {
    const detail = formatCrossSearchLandingDetail(status, new Date("2026-03-11T08:28:13.832Z"));

    expect(detail).toContain("START HERE");
    expect(detail).toContain("Cross Search is the default investigation desk.");
    expect(detail).toContain("Search once to scan PRs, issues, and cluster signals together.");

    const tabs = formatModeTabs("cross-search", "nav");
    expect(tabs).toContain("Cross Search");
    expect(tabs).toContain("PR Search");
    expect(tabs).toContain("{#63c8ff-bg}");
  });

  it("formats action bar chips and list summaries", () => {
    expect(
      formatActionBar([
        { id: "query", slot: 1, label: "Search", shortcut: "/", enabled: true },
        { id: "refresh", slot: 7, label: "Refresh", shortcut: "r", enabled: false },
      ]),
    ).toContain("1 Search");
    expect(
      formatListSummary({
        yieldLabel: "20 hits",
        confidenceLabel: "PR 12 · Issue 5 · Cluster 3",
        coverageLabel: "seed #41793 · cached",
      }),
    ).toContain("seed #41793");
  });
});
