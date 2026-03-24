import * as path from "node:path";
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
  extractChangedFileTerms,
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

type PathFileMetadata = {
  path: string;
  stem: string;
  dir: string;
};

export type SemanticScoreBreakdown = {
  lexicalScore: number;
  structuralScore: number;
  embeddingScore: number;
  score: number;
};

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
  const prodMetadataByCandidate = new Map<number, PathFileMetadata[]>();
  const testMetadataByCandidate = new Map<number, PathFileMetadata[]>();
  const testsByStem = new Map<string, PathFileMetadata[]>();
  const seedProdSet = new Set(seedCandidate?.prodFiles ?? []);

  for (const candidate of candidates) {
    const prodMetadata = candidate.prodFiles.map((file) => ({
      path: file,
      stem: getFileStem(file),
      dir: path.dirname(file),
    }));
    const testMetadata = candidate.testFiles.map((file) => ({
      path: file,
      stem: getFileStem(file),
      dir: path.dirname(file),
    }));
    prodMetadataByCandidate.set(candidate.prNumber, prodMetadata);
    testMetadataByCandidate.set(candidate.prNumber, testMetadata);
    for (const file of candidate.prodFiles) {
      prodCounts.set(file, (prodCounts.get(file) ?? 0) + 1);
    }
    for (const file of candidate.testFiles) {
      testCounts.set(file, (testCounts.get(file) ?? 0) + 1);
    }
    for (const metadata of testMetadata) {
      const rows = testsByStem.get(metadata.stem) ?? [];
      rows.push(metadata);
      testsByStem.set(metadata.stem, rows);
    }
  }

  const relevantProdFiles = new Set<string>();
  for (const candidate of candidates) {
    for (const metadata of prodMetadataByCandidate.get(candidate.prNumber) ?? []) {
      const matchingTests = testsByStem.get(metadata.stem) ?? [];
      const hasCompanionTest = matchingTests.some((testMetadata) =>
        isCompanionTest(metadata.path, testMetadata.path),
      );
      if (
        (prodCounts.get(metadata.path) ?? 0) >= 2 ||
        seedProdSet.has(metadata.path) ||
        hasCompanionTest
      ) {
        relevantProdFiles.add(metadata.path);
      }
    }
  }

  const relevantProdByStem = new Map<string, PathFileMetadata[]>();
  for (const candidate of candidates) {
    for (const metadata of prodMetadataByCandidate.get(candidate.prNumber) ?? []) {
      if (!relevantProdFiles.has(metadata.path)) {
        continue;
      }
      const rows = relevantProdByStem.get(metadata.stem) ?? [];
      rows.push(metadata);
      relevantProdByStem.set(metadata.stem, rows);
    }
  }

  const relevantProdCountByCandidate = new Map<number, number>();
  for (const candidate of candidates) {
    relevantProdCountByCandidate.set(
      candidate.prNumber,
      (prodMetadataByCandidate.get(candidate.prNumber) ?? []).filter((metadata) =>
        relevantProdFiles.has(metadata.path),
      ).length,
    );
  }

  const relevantTestFiles = new Set<string>();
  for (const candidate of candidates) {
    const candidateRelevantProdCount = relevantProdCountByCandidate.get(candidate.prNumber) ?? 0;
    for (const metadata of testMetadataByCandidate.get(candidate.prNumber) ?? []) {
      const relevantProdMatches = relevantProdByStem.get(metadata.stem) ?? [];
      const hasCompanionProd = relevantProdMatches.some((prodMetadata) =>
        isCompanionTest(prodMetadata.path, metadata.path),
      );
      if (
        (testCounts.get(metadata.path) ?? 0) >= 2 ||
        hasCompanionProd ||
        (candidateRelevantProdCount > 0 &&
          candidate.testFiles.length <= Math.max(2, candidateRelevantProdCount * 2))
      ) {
        relevantTestFiles.add(metadata.path);
      }
    }
  }

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
  embeddingScore?: number;
}): SemanticScoreBreakdown {
  const { seed, candidate } = params;
  const seedTerms = extractSemanticTerms(normalizeClusterSearchTitle(seed.title), seed.body).slice(
    0,
    6,
  );
  const candidateTerms = new Set(
    extractSemanticTerms(normalizeClusterSearchTitle(candidate.title), candidate.body),
  );
  const matchedTerms =
    seedTerms.length === 0 ? 0 : seedTerms.filter((term) => candidateTerms.has(term)).length;
  const lexicalScore =
    seedTerms.length === 0 ? 0 : matchedTerms / Math.max(2, Math.min(6, seedTerms.length));

  const seedPathTerms = new Map(
    seed.changedFiles
      .filter((file) => file.kind !== "other")
      .flatMap((file) => extractChangedFileTerms(file.path))
      .map((term) => [`${term.kind}:${term.value}`, term.kind]),
  );
  const candidatePathTerms = new Set(
    candidate.changedFiles
      .filter((file) => file.kind !== "other")
      .flatMap((file) => extractChangedFileTerms(file.path))
      .map((term) => `${term.kind}:${term.value}`),
  );
  const termWeights = {
    stem: 1.3,
    dir_pair: 1,
    dir: 0.7,
  } as const;
  let matchedPathWeight = 0;
  let totalPathWeight = 0;
  for (const [termKey, kind] of seedPathTerms) {
    const weight = termWeights[kind];
    totalPathWeight += weight;
    if (candidatePathTerms.has(termKey)) {
      matchedPathWeight += weight;
    }
  }
  const structuralScore =
    totalPathWeight === 0 ? 0 : Math.min(1, matchedPathWeight / totalPathWeight);
  const embeddingScore = Math.max(0, params.embeddingScore ?? 0);

  const score =
    params.embeddingScore === undefined
      ? Math.min(1, lexicalScore * 0.55 + structuralScore * 0.45)
      : Math.min(1, lexicalScore * 0.3 + structuralScore * 0.3 + embeddingScore * 0.4);

  return {
    lexicalScore,
    structuralScore,
    embeddingScore,
    score,
  };
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

export function buildClusterSemanticText(params: {
  title: string;
  body: string;
  changedFiles: PullRequestChangedFile[];
}): string {
  const bodySnippet = normalizeSearchText(params.body)
    .split(/[\n.!?]+/g)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(". ");
  const pathTerms = uniqueStrings(
    params.changedFiles
      .filter((file) => file.kind !== "other")
      .flatMap((file) => extractChangedFileTerms(file.path))
      .map((term) => term.value),
  ).slice(0, 10);
  return [normalizeClusterSearchTitle(params.title), bodySnippet, pathTerms.join(" ")]
    .filter(Boolean)
    .join("\n");
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
