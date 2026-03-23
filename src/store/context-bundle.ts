import type {
  ClusterPullRequestAnalysis,
  IssueSearchResult,
  MergeReadiness,
  PrContextBundle,
  PriorityCandidate,
  PullRequestReviewFact,
  PullRequestShowResult,
  SearchResult,
} from "../types.js";

export function buildPrContextBundle(params: {
  candidate: PriorityCandidate;
  payload: PullRequestShowResult;
  linkedIssues: IssueSearchResult[];
  relatedPullRequests: Iterable<SearchResult>;
  cluster: ClusterPullRequestAnalysis | null;
  latestReviewFact: PullRequestReviewFact | null;
  mergeReadiness: MergeReadiness | null;
}): PrContextBundle {
  return {
    candidate: {
      ...params.candidate,
      pr: params.payload.pr
        ? {
            ...params.payload.pr,
            score: params.candidate.score,
          }
        : params.candidate.pr,
    },
    comments: params.payload.comments,
    linkedIssues: params.linkedIssues,
    relatedPullRequests: Array.from(params.relatedPullRequests).sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.prNumber - left.prNumber,
    ),
    cluster: params.cluster,
    latestReviewFact: params.latestReviewFact,
    mergeReadiness: params.mergeReadiness,
  };
}
