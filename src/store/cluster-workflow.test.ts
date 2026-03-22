import { describe, expect, it } from "vitest";
import type { ClusterCandidate } from "../types.js";
import {
  buildLinkedIssueClusterResult,
  buildSemanticOnlyClusterResult,
  classifyNearbyExcludedCandidate,
  describeReasonCodes,
  evaluateSemanticOnlyCandidate,
  orderSemanticOnlyCandidates,
  rankClusterDecisionSet,
} from "./cluster-workflow.js";

function makeCandidate(
  prNumber: number,
  overrides: Partial<ClusterCandidate> = {},
): ClusterCandidate {
  return {
    prNumber,
    title: `PR ${prNumber}`,
    url: `https://example.test/pr/${prNumber}`,
    state: "open",
    updatedAt: "2026-03-18T10:00:00.000Z",
    headSha: `sha-${prNumber}`,
    matchedBy: "linked_issue",
    linkedIssues: [41789],
    prodFiles: ["src/a.ts"],
    testFiles: [],
    otherFiles: [],
    relevantProdFiles: ["src/a.ts"],
    relevantTestFiles: [],
    noiseFilesCount: 0,
    status: "same_cluster_candidate",
    reasonCodes: ["same_linked_issue"],
    reason: "shares the linked issue",
    semanticScore: 0.6,
    featureVector: {
      matchedBy: "linked_issue",
      linkedIssueOverlap: 1,
      linkedIssueCount: 1,
      totalProdFileCount: 1,
      totalTestFileCount: 0,
      totalOtherFileCount: 0,
      relevantProdFileCount: 1,
      relevantTestFileCount: 0,
      noiseFilesCount: 0,
      semanticScore: 0.6,
    },
    ...overrides,
  };
}

describe("cluster workflow helpers", () => {
  it("orders semantic-only candidates by score then recency", () => {
    const ordered = orderSemanticOnlyCandidates(
      [
        makeCandidate(2, { semanticScore: 0.4, updatedAt: "2026-03-18T09:00:00.000Z" }),
        makeCandidate(3, { semanticScore: 0.7, updatedAt: "2026-03-18T08:00:00.000Z" }),
        makeCandidate(4, { semanticScore: 0.7, updatedAt: "2026-03-18T11:00:00.000Z" }),
      ],
      2,
    );

    expect(ordered.map((candidate) => candidate.prNumber)).toEqual([4, 3]);
  });

  it("marks the best base and superseded candidates with decision traces", () => {
    const result = rankClusterDecisionSet({
      rankedCandidates: [
        makeCandidate(10, {
          relevantProdFiles: ["src/a.ts", "src/b.ts"],
          prodFiles: ["src/a.ts", "src/b.ts"],
          featureVector: {
            matchedBy: "linked_issue",
            linkedIssueOverlap: 1,
            linkedIssueCount: 1,
            totalProdFileCount: 2,
            totalTestFileCount: 0,
            totalOtherFileCount: 0,
            relevantProdFileCount: 2,
            relevantTestFileCount: 0,
            noiseFilesCount: 0,
            semanticScore: 0.6,
          },
        }),
        makeCandidate(11, {
          relevantProdFiles: ["src/a.ts"],
          prodFiles: ["src/a.ts"],
          noiseFilesCount: 1,
          otherFiles: ["docs/a.md"],
          featureVector: {
            matchedBy: "linked_issue",
            linkedIssueOverlap: 1,
            linkedIssueCount: 1,
            totalProdFileCount: 1,
            totalTestFileCount: 0,
            totalOtherFileCount: 1,
            relevantProdFileCount: 1,
            relevantTestFileCount: 0,
            noiseFilesCount: 1,
            semanticScore: 0.6,
          },
        }),
      ],
      limit: 2,
    });

    expect(result.bestBase?.prNumber).toBe(10);
    expect(result.sameClusterCandidates[0]).toMatchObject({
      prNumber: 10,
      status: "best_base",
    });
    expect(result.sameClusterCandidates[1]).toMatchObject({
      prNumber: 11,
      status: "superseded_candidate",
      supersededBy: 10,
    });
    expect(result.decisionTrace.map((trace) => trace.outcome)).toEqual([
      "best_base",
      "superseded_candidate",
    ]);
  });

  it("evaluates semantic-only candidates with stable include and exclude behavior", () => {
    const included = evaluateSemanticOnlyCandidate(
      makeCandidate(20, {
        matchedBy: "local_semantic",
        linkedIssues: [],
        semanticScore: 0.45,
        featureVector: {
          matchedBy: "local_semantic",
          linkedIssueOverlap: 0,
          linkedIssueCount: 0,
          totalProdFileCount: 1,
          totalTestFileCount: 0,
          totalOtherFileCount: 0,
          relevantProdFileCount: 1,
          relevantTestFileCount: 0,
          noiseFilesCount: 0,
          semanticScore: 0.45,
        },
      }),
    );
    expect(included.included?.reason).toBe("semantic-only candidate");
    expect(included.excluded).toBeNull();

    const excluded = evaluateSemanticOnlyCandidate(
      makeCandidate(21, {
        matchedBy: "local_semantic",
        linkedIssues: [50001],
        semanticScore: 0.8,
        featureVector: {
          matchedBy: "local_semantic",
          linkedIssueOverlap: 0,
          linkedIssueCount: 1,
          totalProdFileCount: 1,
          totalTestFileCount: 0,
          totalOtherFileCount: 0,
          relevantProdFileCount: 1,
          relevantTestFileCount: 0,
          noiseFilesCount: 0,
          semanticScore: 0.8,
        },
      }),
    );
    expect(excluded.included).toBeNull();
    expect(excluded.excluded?.excludedReasonCode).toBe("different_linked_issue");
  });

  it("classifies nearby candidates by linked issues and noise before weak semantic fallback", () => {
    const linkedIssue = classifyNearbyExcludedCandidate({
      candidate: makeCandidate(30, {
        linkedIssues: [41789, 49999],
      }),
      clusterIssueNumbers: [41789],
    });
    expect(linkedIssue.excludedReasonCode).toBe("different_linked_issue");

    const noiseDominated = classifyNearbyExcludedCandidate({
      candidate: makeCandidate(31, {
        linkedIssues: [41789],
        relevantProdFiles: ["src/a.ts"],
        relevantTestFiles: [],
        noiseFilesCount: 4,
      }),
      clusterIssueNumbers: [41789],
    });
    expect(noiseDominated.excludedReasonCode).toBe("noise_dominated");

    const weak = classifyNearbyExcludedCandidate({
      candidate: makeCandidate(32, {
        linkedIssues: [41789],
        relevantProdFiles: ["src/a.ts", "src/b.ts"],
        prodFiles: ["src/a.ts", "src/b.ts"],
        noiseFilesCount: 0,
      }),
      clusterIssueNumbers: [41789],
    });
    expect(weak.excludedReasonCode).toBe("semantic_weak_match");
  });

  it("renders stable reason descriptions", () => {
    expect(describeReasonCodes(["broader_relevant_prod_coverage", "adds_companion_tests"])).toBe(
      "adds companion tests, broader relevant production coverage",
    );
  });

  it("assembles semantic-only and linked-issue results with final traces", () => {
    const semantic = buildSemanticOnlyClusterResult({
      seed: {
        number: 40,
        title: "Seed",
        url: "https://example.test/pr/40",
        state: "open",
        updated_at: "2026-03-18T10:00:00.000Z",
      },
      sameClusterCandidates: [makeCandidate(41, { matchedBy: "local_semantic", linkedIssues: [] })],
      nearbyButExcluded: [],
      decisionTrace: [],
      limit: 5,
    });
    expect(semantic.clusterBasis).toBe("semantic_only");
    expect(semantic.decisionTrace.at(-1)?.outcome).toBe("semantic_only_result");

    const linked = buildLinkedIssueClusterResult({
      seed: {
        number: 50,
        title: "Seed",
        url: "https://example.test/pr/50",
        state: "open",
        updated_at: "2026-03-18T10:00:00.000Z",
      },
      clusterIssueNumbers: [41789],
      bestBase: makeCandidate(51),
      sameClusterCandidates: [makeCandidate(51, { status: "best_base" })],
      nearbyButExcluded: [],
      mergeReadiness: null,
      decisionTrace: [],
      limit: 5,
    });
    expect(linked.clusterBasis).toBe("linked_issue");
    expect(linked.bestBase?.prNumber).toBe(51);
    expect(linked.decisionTrace.at(-1)?.outcome).toBe("linked_issue_result");
  });
});
