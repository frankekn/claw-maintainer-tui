import { describe, expect, it } from "vitest";
import {
  buildStatusRows,
  formatClusterDetail,
  formatHeader,
  formatResultRow,
  formatStatusDetail,
} from "./format.js";
import type { ClusterCandidate, StatusSnapshot } from "../types.js";

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

describe("tui formatting", () => {
  it("formats a dense header with sync ages and vector badge", () => {
    const header = formatHeader(
      {
        repo: "openclaw/openclaw",
        dbPath: "/tmp/clawlens.sqlite",
        activeModeLabel: "PR Search",
        ftsOnly: false,
        status,
        busyMessage: null,
        errorMessage: null,
      },
      new Date("2026-03-11T08:28:13.832Z"),
    );
    expect(header).toContain("PR Search");
    expect(header).toContain("repo openclaw/openclaw");
    expect(header).toContain("pr 1h");
    expect(header).toContain("vector ok");
  });

  it("formats status detail and rows from the repository snapshot", () => {
    expect(formatStatusDetail(status, new Date("2026-03-11T08:28:13.832Z"))).toContain(
      "prs: 23935",
    );
    expect(buildStatusRows(status)).toEqual([
      { kind: "status", label: "PRs", value: "23935" },
      { kind: "status", label: "Issues", value: "17535" },
      { kind: "status", label: "PR Labels", value: "61148" },
      { kind: "status", label: "Issue Labels", value: "14230" },
      { kind: "status", label: "Comments", value: "100" },
      { kind: "status", label: "Docs", value: "24035" },
      { kind: "status", label: "Vector", value: "available" },
    ]);
  });

  it("formats cluster candidate rows and detailed reasoning text", () => {
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

    expect(formatResultRow({ kind: "cluster-candidate", candidate })).toContain("prod:2/2");
    expect(
      formatClusterDetail(
        {
          seedLabel: "seed_pr: #41793 prune image-containing tool results",
          clusterBasis: "linked_issue",
          clusterIssues: [41789],
          mergeSummary: "needs_work via review_fact",
        },
        candidate,
      ),
    ).toContain("reason: broader relevant production coverage");
  });
});
