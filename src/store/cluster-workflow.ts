import type {
  ClusterCandidate,
  ClusterDecisionTrace,
  ClusterExcludedCandidate,
  ClusterPullRequestAnalysis,
  ClusterReasonCode,
  MergeReadiness,
  PrState,
} from "../types.js";
import {
  buildClusterSeed,
  buildClusterDecisionTrace,
  buildExcludedTrace,
  linkedIssueResultSummary,
  semanticOnlyResultSummary,
  withClusterFeatures,
} from "./cluster-analysis.js";
import {
  buildBestBaseReasonCodes,
  buildExcludedCandidate,
  buildSupersededReasonCodes,
} from "./cluster-logic.js";
import { uniqueStrings } from "./text.js";

const SEMANTIC_ONLY_MIN_SCORE = 0.38;

function describeSemanticConfidence(score: number): string {
  if (score >= 0.6) {
    return "high";
  }
  if (score >= SEMANTIC_ONLY_MIN_SCORE) {
    return "medium";
  }
  return "low";
}

export function describeReasonCodes(codes: ClusterReasonCode[]): string {
  const phrases = codes.flatMap((code) => {
    switch (code) {
      case "only_exact_linked_pr":
        return ["only exact linked PR in cluster"];
      case "broader_relevant_prod_coverage":
        return ["broader relevant production coverage"];
      case "adds_companion_tests":
        return ["adds companion tests"];
      case "less_unrelated_churn":
        return ["less unrelated churn"];
      case "narrower_relevant_prod_coverage":
        return ["narrower relevant production coverage"];
      case "fewer_companion_tests":
        return ["fewer companion tests"];
      case "more_unrelated_churn":
        return ["more unrelated churn"];
      case "semantic_only_candidate":
        return ["semantic-only candidate"];
      case "same_linked_issue":
        return ["shares the linked issue"];
      case "discovered_via_live_issue_search":
        return ["discovered via live issue search"];
      default:
        return [];
    }
  });
  return uniqueStrings(phrases).join(", ");
}

export function orderSemanticOnlyCandidates(
  candidates: ClusterCandidate[],
  limit: number,
): ClusterCandidate[] {
  return [...candidates]
    .sort((left, right) => {
      if ((right.semanticScore ?? 0) !== (left.semanticScore ?? 0)) {
        return (right.semanticScore ?? 0) - (left.semanticScore ?? 0);
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, limit);
}

export function evaluateSemanticOnlyCandidate(candidate: ClusterCandidate): {
  included: ClusterCandidate | null;
  excluded: ClusterExcludedCandidate | null;
  decisionTrace: ClusterDecisionTrace[];
} {
  if (candidate.linkedIssues.length > 0) {
    const excluded = buildExcludedCandidate(
      candidate,
      "different_linked_issue",
      `different_linked_issue: ${candidate.linkedIssues.map((issue) => `#${issue}`).join(", ")}`,
    );
    return {
      included: null,
      excluded,
      decisionTrace: [buildExcludedTrace(excluded)],
    };
  }

  const score = candidate.semanticScore ?? 0;

  if (score >= SEMANTIC_ONLY_MIN_SCORE) {
    const included = withClusterFeatures(
      {
        ...candidate,
        reason: `semantic-only candidate (${describeSemanticConfidence(score)} confidence, score ${score.toFixed(2)})`,
      },
      [],
    );
    return {
      included,
      excluded: null,
      decisionTrace: [
        buildClusterDecisionTrace({
          phase: "candidate",
          prNumber: included.prNumber,
          matchedBy: included.matchedBy,
          outcome: "included",
          summary: included.reason ?? "Semantic-only candidate retained.",
          featureVector: included.featureVector,
          reasonCodes: included.reasonCodes,
        }),
      ],
    };
  }

  const excluded = buildExcludedCandidate(
    candidate,
    "semantic_weak_match",
    `semantic_weak_match: ${describeSemanticConfidence(score)} confidence score ${score.toFixed(2)}`,
  );
  return {
    included: null,
    excluded,
    decisionTrace: [buildExcludedTrace(excluded)],
  };
}

export function classifyNearbyExcludedCandidate(params: {
  candidate: ClusterCandidate;
  clusterIssueNumbers: number[];
}): ClusterExcludedCandidate {
  const otherLinkedIssues = params.candidate.linkedIssues.filter(
    (issue) => !params.clusterIssueNumbers.includes(issue),
  );
  if (otherLinkedIssues.length > 0) {
    return buildExcludedCandidate(
      params.candidate,
      "different_linked_issue",
      `different_linked_issue: ${otherLinkedIssues.map((issue) => `#${issue}`).join(", ")}`,
    );
  }
  const relevantCount =
    params.candidate.relevantProdFiles.length + params.candidate.relevantTestFiles.length;
  const noiseRatio = params.candidate.noiseFilesCount / Math.max(1, relevantCount);
  if (
    (relevantCount === 0 && params.candidate.noiseFilesCount >= 4) ||
    (relevantCount <= 2 && params.candidate.noiseFilesCount >= 6 && noiseRatio >= 3)
  ) {
    return buildExcludedCandidate(
      params.candidate,
      "noise_dominated",
      `noise_dominated: unrelated churn outweighs issue-relevant paths (noise ratio ${noiseRatio.toFixed(1)})`,
    );
  }
  const score = params.candidate.semanticScore ?? 0;
  return buildExcludedCandidate(
    params.candidate,
    "semantic_weak_match",
    `semantic_weak_match: ${describeSemanticConfidence(score)} confidence neighbor without exact issue link (score ${score.toFixed(2)})`,
  );
}

export function rankClusterDecisionSet(params: {
  rankedCandidates: ClusterCandidate[];
  limit: number;
}): {
  bestBase: ClusterCandidate | null;
  sameClusterCandidates: ClusterCandidate[];
  decisionTrace: ClusterDecisionTrace[];
} {
  const bestBase = params.rankedCandidates[0] ?? null;
  const runnerUp = params.rankedCandidates[1] ?? null;
  const decisionTrace: ClusterDecisionTrace[] = [];
  const sameClusterCandidates = params.rankedCandidates
    .slice(0, params.limit)
    .map((candidate, index) => {
      if (!bestBase) {
        return candidate;
      }
      if (index === 0) {
        const reasonCodes = buildBestBaseReasonCodes(candidate, runnerUp);
        const rankedCandidate = {
          ...candidate,
          status: "best_base" as const,
          reasonCodes,
          reason: describeReasonCodes(reasonCodes),
        };
        decisionTrace.push(
          buildClusterDecisionTrace({
            phase: "rank",
            prNumber: rankedCandidate.prNumber,
            matchedBy: rankedCandidate.matchedBy,
            outcome: rankedCandidate.status,
            summary: rankedCandidate.reason ?? "Selected as best base.",
            featureVector: rankedCandidate.featureVector,
            reasonCodes: rankedCandidate.reasonCodes,
          }),
        );
        return rankedCandidate;
      }
      const reasonCodes = buildSupersededReasonCodes(bestBase, candidate);
      if (reasonCodes.length > 0) {
        const rankedCandidate = {
          ...candidate,
          status: "superseded_candidate" as const,
          supersededBy: bestBase.prNumber,
          reasonCodes,
          reason: describeReasonCodes(reasonCodes),
        };
        decisionTrace.push(
          buildClusterDecisionTrace({
            phase: "rank",
            prNumber: rankedCandidate.prNumber,
            matchedBy: rankedCandidate.matchedBy,
            outcome: rankedCandidate.status,
            summary: rankedCandidate.reason ?? "Candidate superseded by the best base.",
            featureVector: rankedCandidate.featureVector,
            reasonCodes: rankedCandidate.reasonCodes,
          }),
        );
        return rankedCandidate;
      }
      decisionTrace.push(
        buildClusterDecisionTrace({
          phase: "rank",
          prNumber: candidate.prNumber,
          matchedBy: candidate.matchedBy,
          outcome: candidate.status,
          summary: candidate.reason ?? "Candidate kept in same cluster.",
          featureVector: candidate.featureVector,
          reasonCodes: candidate.reasonCodes,
        }),
      );
      return candidate;
    });

  return {
    bestBase,
    sameClusterCandidates,
    decisionTrace,
  };
}

export function buildSemanticOnlyClusterResult(params: {
  seed: {
    number: number;
    title: string;
    url: string;
    state: PrState;
    updated_at: string;
  };
  sameClusterCandidates: ClusterCandidate[];
  nearbyButExcluded: ClusterExcludedCandidate[];
  decisionTrace: ClusterDecisionTrace[];
  limit: number;
}): ClusterPullRequestAnalysis {
  return {
    seedPr: buildClusterSeed(params.seed),
    clusterBasis: "semantic_only",
    clusterIssueNumbers: [],
    bestBase: null,
    sameClusterCandidates: params.sameClusterCandidates,
    nearbyButExcluded: params.nearbyButExcluded.slice(0, params.limit),
    mergeReadiness: null,
    decisionTrace: [
      ...params.decisionTrace,
      buildClusterDecisionTrace({
        phase: "result",
        prNumber: null,
        matchedBy: null,
        outcome: "semantic_only_result",
        summary: semanticOnlyResultSummary(params.sameClusterCandidates.length),
      }),
    ],
  };
}

export function buildLinkedIssueClusterResult(params: {
  seed: {
    number: number;
    title: string;
    url: string;
    state: PrState;
    updated_at: string;
  };
  clusterIssueNumbers: number[];
  bestBase: ClusterCandidate | null;
  sameClusterCandidates: ClusterCandidate[];
  nearbyButExcluded: ClusterExcludedCandidate[];
  mergeReadiness: MergeReadiness | null;
  decisionTrace: ClusterDecisionTrace[];
  limit: number;
}): ClusterPullRequestAnalysis {
  const resolvedBestBase =
    params.sameClusterCandidates.find((candidate) => candidate.status === "best_base") ??
    params.bestBase;

  return {
    seedPr: buildClusterSeed(params.seed),
    clusterBasis: "linked_issue",
    clusterIssueNumbers: params.clusterIssueNumbers,
    bestBase: resolvedBestBase,
    sameClusterCandidates: params.sameClusterCandidates,
    nearbyButExcluded: params.nearbyButExcluded.slice(0, params.limit),
    mergeReadiness: params.mergeReadiness,
    decisionTrace: [
      ...params.decisionTrace,
      buildClusterDecisionTrace({
        phase: "result",
        prNumber: resolvedBestBase?.prNumber ?? null,
        matchedBy: resolvedBestBase?.matchedBy ?? null,
        outcome: resolvedBestBase ? "linked_issue_result" : "linked_issue_result_empty",
        summary: linkedIssueResultSummary(params.clusterIssueNumbers, resolvedBestBase),
        featureVector: resolvedBestBase?.featureVector,
        reasonCodes: resolvedBestBase?.reasonCodes,
      }),
    ],
  };
}
