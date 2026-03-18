import type {
  ClusterCandidate,
  ClusterExcludedCandidate,
  ClusterExcludedReasonCode,
  ClusterMatchSource,
  ClusterReasonCode,
  PullRequestChangedFile,
} from "../types.js";
import { withClusterFeatures } from "./cluster-analysis.js";
import {
  buildCrossReferenceQuery,
  extractSemanticTerms,
  getFileStem,
  isCompanionTest,
  normalizeClusterSearchTitle,
  normalizeSearchText,
  uniqueStrings,
} from "./text.js";

function setContainsAll(left: Set<string>, right: Set<string>): boolean {
  for (const value of right) {
    if (!left.has(value)) {
      return false;
    }
  }
  return true;
}

export function annotateRelevantCoverage(
  candidate: ClusterCandidate,
  relevantProdFiles: Set<string>,
  relevantTestFiles: Set<string>,
  clusterIssueNumbers: number[],
): ClusterCandidate {
  const relevantProd = candidate.prodFiles.filter((file) => relevantProdFiles.has(file));
  const relevantTest = candidate.testFiles.filter((file) => relevantTestFiles.has(file));
  const noiseFilesCount =
    candidate.prodFiles.length +
    candidate.testFiles.length +
    candidate.otherFiles.length -
    relevantProd.length -
    relevantTest.length;
  return withClusterFeatures(
    {
      ...candidate,
      relevantProdFiles: relevantProd,
      relevantTestFiles: relevantTest,
      noiseFilesCount,
    },
    clusterIssueNumbers,
  );
}

export function buildRelevantPathSets(
  seedPrNumber: number,
  candidates: ClusterCandidate[],
): {
  relevantProdFiles: Set<string>;
  relevantTestFiles: Set<string>;
} {
  const prodCounts = new Map<string, number>();
  const testCounts = new Map<string, number>();
  const seedCandidate = candidates.find((candidate) => candidate.prNumber === seedPrNumber) ?? null;

  for (const candidate of candidates) {
    for (const file of candidate.prodFiles) {
      prodCounts.set(file, (prodCounts.get(file) ?? 0) + 1);
    }
    for (const file of candidate.testFiles) {
      testCounts.set(file, (testCounts.get(file) ?? 0) + 1);
    }
  }

  const relevantProdFiles = new Set(
    candidates.flatMap((candidate) =>
      candidate.prodFiles.filter(
        (file) =>
          (prodCounts.get(file) ?? 0) >= 2 ||
          seedCandidate?.prodFiles.includes(file) ||
          candidates.some((otherCandidate) =>
            otherCandidate.testFiles.some((testFile) => isCompanionTest(file, testFile)),
          ),
      ),
    ),
  );
  const relevantTestFiles = new Set(
    candidates.flatMap((candidate) =>
      candidate.testFiles.filter((file) => {
        const candidateRelevantProdCount = candidate.prodFiles.filter((prodFile) =>
          relevantProdFiles.has(prodFile),
        ).length;
        return (
          (testCounts.get(file) ?? 0) >= 2 ||
          Array.from(relevantProdFiles).some((prodFile) => isCompanionTest(prodFile, file)) ||
          (candidateRelevantProdCount > 0 &&
            candidate.testFiles.length <= Math.max(2, candidateRelevantProdCount * 2))
        );
      }),
    ),
  );

  return { relevantProdFiles, relevantTestFiles };
}

export function buildBestBaseReasonCodes(
  bestBase: ClusterCandidate,
  runnerUp: ClusterCandidate | null,
): ClusterReasonCode[] {
  if (!runnerUp) {
    return ["only_exact_linked_pr"];
  }
  const out: ClusterReasonCode[] = [];
  if (bestBase.relevantProdFiles.length > runnerUp.relevantProdFiles.length) {
    out.push("broader_relevant_prod_coverage");
  }
  if (bestBase.relevantTestFiles.length > runnerUp.relevantTestFiles.length) {
    out.push("adds_companion_tests");
  }
  if (bestBase.noiseFilesCount < runnerUp.noiseFilesCount) {
    out.push("less_unrelated_churn");
  }
  return out.length > 0 ? out : ["same_linked_issue"];
}

export function buildSupersededReasonCodes(
  bestBase: ClusterCandidate,
  candidate: ClusterCandidate,
): ClusterReasonCode[] {
  const out: ClusterReasonCode[] = [];
  const bestRelevantProdSet = new Set(bestBase.relevantProdFiles);
  const candidateRelevantProdSet = new Set(candidate.relevantProdFiles);
  const bestRelevantTestSet = new Set(bestBase.relevantTestFiles);
  const candidateRelevantTestSet = new Set(candidate.relevantTestFiles);

  if (
    candidate.relevantProdFiles.length > 0 &&
    bestBase.relevantProdFiles.length > candidate.relevantProdFiles.length &&
    setContainsAll(bestRelevantProdSet, candidateRelevantProdSet)
  ) {
    out.push("narrower_relevant_prod_coverage");
  }
  if (
    bestBase.relevantTestFiles.length > candidate.relevantTestFiles.length &&
    setContainsAll(bestRelevantTestSet, candidateRelevantTestSet)
  ) {
    out.push("fewer_companion_tests");
  }
  if (candidate.noiseFilesCount > bestBase.noiseFilesCount) {
    out.push("more_unrelated_churn");
  }
  return out;
}

export function rankClusterCandidates(
  clusterIssueNumbers: number[],
  left: ClusterCandidate,
  right: ClusterCandidate,
): number {
  const leftIssueMatches = left.linkedIssues.filter((issue) =>
    clusterIssueNumbers.includes(issue),
  ).length;
  const rightIssueMatches = right.linkedIssues.filter((issue) =>
    clusterIssueNumbers.includes(issue),
  ).length;
  if (leftIssueMatches !== rightIssueMatches) {
    return rightIssueMatches - leftIssueMatches;
  }
  const stateRank = (value: ClusterCandidate["state"]): number =>
    value === "open" ? 2 : value === "merged" ? 1 : 0;
  const leftState = stateRank(left.state);
  const rightState = stateRank(right.state);
  if (leftState !== rightState) {
    return rightState - leftState;
  }
  if (left.relevantProdFiles.length !== right.relevantProdFiles.length) {
    return right.relevantProdFiles.length - left.relevantProdFiles.length;
  }
  if (left.relevantTestFiles.length !== right.relevantTestFiles.length) {
    return right.relevantTestFiles.length - left.relevantTestFiles.length;
  }
  if (left.noiseFilesCount !== right.noiseFilesCount) {
    return left.noiseFilesCount - right.noiseFilesCount;
  }
  const updatedCompare = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedCompare !== 0) {
    return updatedCompare;
  }
  return right.prNumber - left.prNumber;
}

export function computeSemanticScore(params: {
  seed: { title: string; body: string; changedFiles: PullRequestChangedFile[] };
  candidate: { title: string; body: string; changedFiles: PullRequestChangedFile[] };
}): number {
  const { seed, candidate } = params;
  const seedTerms = extractSemanticTerms(normalizeClusterSearchTitle(seed.title), seed.body).slice(
    0,
    6,
  );
  if (seedTerms.length === 0) {
    return 0;
  }
  const candidateTerms = new Set(
    extractSemanticTerms(normalizeClusterSearchTitle(candidate.title), candidate.body),
  );
  const matchedTerms = seedTerms.filter((term) => candidateTerms.has(term)).length;
  const seedFiles = new Set(
    seed.changedFiles.filter((file) => file.kind !== "other").map((file) => getFileStem(file.path)),
  );
  const candidateFiles = new Set(
    candidate.changedFiles
      .filter((file) => file.kind !== "other")
      .map((file) => getFileStem(file.path)),
  );
  let fileOverlap = 0;
  if (seedFiles.size > 0 && candidateFiles.size > 0) {
    let overlap = 0;
    for (const file of seedFiles) {
      if (candidateFiles.has(file)) {
        overlap += 1;
      }
    }
    fileOverlap = overlap / Math.max(seedFiles.size, candidateFiles.size);
  }
  return Math.min(1, matchedTerms / Math.max(2, Math.min(6, seedTerms.length)) + fileOverlap * 0.3);
}

export function buildLiveSemanticQueries(seed: { title: string; body: string }): string[] {
  const titleQuery = normalizeClusterSearchTitle(seed.title);
  const crossReferenceQuery = buildCrossReferenceQuery(seed.title, seed.body);
  const firstSentenceQuery = extractSemanticTerms(
    normalizeSearchText(seed.body)
      .split(/[\n.!?]+/g)
      .map((value) => value.trim())
      .find((value) => value.length >= 20) ?? "",
  )
    .slice(0, 6)
    .join(" ");
  return uniqueStrings([crossReferenceQuery, titleQuery, firstSentenceQuery]).slice(0, 3);
}

export function buildExcludedCandidate(
  candidate: ClusterCandidate,
  excludedReasonCode: ClusterExcludedReasonCode,
  reason: string,
): ClusterExcludedCandidate {
  return {
    prNumber: candidate.prNumber,
    title: candidate.title,
    url: candidate.url,
    state: candidate.state,
    updatedAt: candidate.updatedAt,
    matchedBy: candidate.matchedBy,
    linkedIssues: candidate.linkedIssues,
    excludedReasonCode,
    semanticScore: candidate.semanticScore,
    reason,
    featureVector: candidate.featureVector,
  };
}

export type { ClusterMatchSource };
