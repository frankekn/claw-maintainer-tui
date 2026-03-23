import type {
  ClusterCandidate,
  ClusterDecisionTrace,
  ClusterExcludedCandidate,
  ClusterExcludedReasonCode,
  ClusterFeatureVector,
  ClusterMatchSource,
  ClusterPullRequestAnalysis,
  PrState,
} from "../types.js";

export function buildClusterFeatureVector(params: {
  candidate: Pick<
    ClusterCandidate,
    | "matchedBy"
    | "linkedIssues"
    | "prodFiles"
    | "testFiles"
    | "otherFiles"
    | "relevantProdFiles"
    | "relevantTestFiles"
    | "noiseFilesCount"
    | "semanticScore"
  >;
  clusterIssueNumbers: number[];
}): ClusterFeatureVector {
  const { candidate, clusterIssueNumbers } = params;
  return {
    matchedBy: candidate.matchedBy,
    linkedIssueOverlap: candidate.linkedIssues.filter((issue) =>
      clusterIssueNumbers.includes(issue),
    ).length,
    linkedIssueCount: candidate.linkedIssues.length,
    totalProdFileCount: candidate.prodFiles.length,
    totalTestFileCount: candidate.testFiles.length,
    totalOtherFileCount: candidate.otherFiles.length,
    relevantProdFileCount: candidate.relevantProdFiles.length,
    relevantTestFileCount: candidate.relevantTestFiles.length,
    noiseFilesCount: candidate.noiseFilesCount,
    semanticScore: candidate.semanticScore ?? 0,
  };
}

export function withClusterFeatures(
  candidate: Omit<ClusterCandidate, "featureVector"> | ClusterCandidate,
  clusterIssueNumbers: number[],
): ClusterCandidate {
  return {
    ...candidate,
    featureVector: buildClusterFeatureVector({ candidate, clusterIssueNumbers }),
  };
}

export function buildClusterDecisionTrace(params: {
  phase: ClusterDecisionTrace["phase"];
  prNumber: number | null;
  matchedBy: ClusterMatchSource | null;
  outcome: string;
  summary: string;
  featureVector?: ClusterFeatureVector;
  reasonCodes?: ClusterDecisionTrace["reasonCodes"];
  excludedReasonCode?: ClusterExcludedReasonCode;
}): ClusterDecisionTrace {
  return {
    phase: params.phase,
    prNumber: params.prNumber,
    matchedBy: params.matchedBy,
    outcome: params.outcome,
    summary: params.summary,
    featureVector: params.featureVector,
    reasonCodes: params.reasonCodes,
    excludedReasonCode: params.excludedReasonCode,
  };
}

export function semanticOnlyResultSummary(count: number): string {
  return count > 0
    ? `Retained ${count} semantic-only candidate${count === 1 ? "" : "s"}.`
    : "No semantic-only candidates passed the overlap threshold.";
}

export function linkedIssueResultSummary(
  clusterIssueNumbers: number[],
  bestBase: ClusterCandidate | null,
): string {
  if (!bestBase) {
    return `No exact linked candidates found for issues ${clusterIssueNumbers.map((issue) => `#${issue}`).join(", ")}.`;
  }
  return `Selected PR #${bestBase.prNumber} as best base for issues ${clusterIssueNumbers.map((issue) => `#${issue}`).join(", ")}.`;
}

export function buildClusterSeed(seed: {
  number: number;
  title: string;
  url: string;
  state: PrState;
  updated_at: string;
}): ClusterPullRequestAnalysis["seedPr"] {
  return {
    prNumber: seed.number,
    title: seed.title,
    url: seed.url,
    state: seed.state,
    updatedAt: seed.updated_at,
  };
}

export function buildExcludedTrace(candidate: ClusterExcludedCandidate): ClusterDecisionTrace {
  return buildClusterDecisionTrace({
    phase: "exclude",
    prNumber: candidate.prNumber,
    matchedBy: candidate.matchedBy,
    outcome: candidate.excludedReasonCode,
    summary: candidate.reason,
    featureVector: candidate.featureVector,
    excludedReasonCode: candidate.excludedReasonCode,
  });
}
