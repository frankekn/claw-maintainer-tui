export type RepoRef = {
  owner: string;
  name: string;
};

export type PrState = "open" | "closed" | "merged";
export type IssueState = "open" | "closed";

export type PullRequestRecord = {
  number: number;
  title: string;
  body: string;
  state: PrState;
  isDraft: boolean;
  author: string;
  baseRef: string;
  headRef: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  labels: string[];
};

export type PullRequestCommentKind = "issue_comment" | "review" | "review_comment";
export type PullRequestLinkSource =
  | "closing_reference"
  | "source_issue_marker"
  | "body_reference"
  | "title_reference";
export type PullRequestChangedFileKind = "prod" | "test" | "other";
export type ReviewFactDecision = "ready" | "needs_work" | "blocked";
export type AttentionState = "seen" | "watch" | "ignore";
export type PriorityAttentionState = AttentionState | "new";
export type ClusterMatchSource =
  | "linked_issue"
  | "live_issue_search"
  | "local_semantic"
  | "live_semantic";
export type ClusterReasonCode =
  | "only_exact_linked_pr"
  | "broader_relevant_prod_coverage"
  | "adds_companion_tests"
  | "less_unrelated_churn"
  | "narrower_relevant_prod_coverage"
  | "fewer_companion_tests"
  | "more_unrelated_churn"
  | "semantic_only_candidate"
  | "same_linked_issue"
  | "discovered_via_live_issue_search";
export type ClusterExcludedReasonCode =
  | "different_linked_issue"
  | "semantic_weak_match"
  | "noise_dominated";

export type PullRequestCommentRecord = {
  sourceId: string;
  kind: PullRequestCommentKind;
  author: string;
  body: string;
  path: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
};

export type HydratedPullRequest = {
  pr: PullRequestRecord;
  comments: PullRequestCommentRecord[];
};

export type IssueRecord = {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  labels: string[];
};

export type SearchDocKind = "pr_body" | "comment";

export type SearchDocument = {
  docId: string;
  prNumber: number;
  kind: SearchDocKind;
  title: string;
  text: string;
  updatedAt: string;
  hash: string;
};

export type SearchFilters = {
  prNumber?: number;
  labels: string[];
  state?: "open" | "closed" | "merged" | "all";
  author?: string;
  branch?: string;
};

export type ParsedSearchQuery = {
  raw: string;
  text: string;
  filters: SearchFilters;
};

export type SearchResult = {
  prNumber: number;
  title: string;
  url: string;
  state: PrState;
  author: string;
  labels: string[];
  updatedAt: string;
  score: number;
  matchedDocKind: SearchDocKind;
  matchedExcerpt: string;
};

export type PullRequestShowComment = {
  kind: string;
  author: string;
  createdAt: string;
  url: string;
  excerpt: string;
};

export type PullRequestShowResult = {
  pr: SearchResult | null;
  comments: PullRequestShowComment[];
};

export type PriorityReasonType =
  | "watch"
  | "freshness"
  | "linked_issue"
  | "related_pr"
  | "hub_bonus";

export type PriorityReason = {
  type: PriorityReasonType;
  label: string;
  points: number;
};

export type PriorityCandidate = {
  pr: SearchResult;
  attentionState: PriorityAttentionState;
  score: number;
  reasons: PriorityReason[];
  linkedIssueCount: number;
  relatedPullRequestCount: number;
  badges: {
    draft: boolean;
    maintainer: boolean;
  };
};

export type PriorityClusterRecommendation = "merged_exists" | "open_variants" | "semantic_family";

export type PriorityClusterSummary = {
  clusterKey: string;
  basis: "linked_issue" | "semantic_only";
  representative: PriorityCandidate;
  openMembers: PriorityCandidate[];
  score: number;
  totalPrCount: number;
  openPrCount: number;
  mergedPrCount: number;
  linkedIssueCount: number;
  clusterIssueNumbers: number[];
  statusLabel: string;
  statusReason: string;
  recommendation: PriorityClusterRecommendation;
  solvedByPrNumber: number | null;
};

export type PriorityInboxItem =
  | { kind: "pr"; candidate: PriorityCandidate }
  | { kind: "cluster"; cluster: PriorityClusterSummary };

export type PullRequestLinkedIssue = {
  issueNumber: number;
  linkSource: PullRequestLinkSource;
};

export type PullRequestChangedFile = {
  path: string;
  kind: PullRequestChangedFileKind;
};

export type PullRequestStatusCheck = {
  name: string;
  status: string;
  conclusion: string | null;
  workflowName: string | null;
  detailsUrl: string | null;
};

export type PullRequestFactRecord = {
  prNumber: number;
  headSha: string;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  mergeable: string | null;
  statusChecks: PullRequestStatusCheck[];
  linkedIssues: PullRequestLinkedIssue[];
  changedFiles: PullRequestChangedFile[];
  fetchedAt: string;
};

export type PullRequestReviewFact = {
  repo: string;
  prNumber: number;
  headSha: string;
  decision: ReviewFactDecision;
  summary: string;
  commands: string[];
  failingTests: string[];
  source: string;
  recordedAt: string;
};

export type ClusterCandidateStatus =
  | "best_base"
  | "same_cluster_candidate"
  | "superseded_candidate"
  | "possible_same_cluster";

export type ClusterFeatureVector = {
  matchedBy: ClusterMatchSource;
  linkedIssueOverlap: number;
  linkedIssueCount: number;
  totalProdFileCount: number;
  totalTestFileCount: number;
  totalOtherFileCount: number;
  relevantProdFileCount: number;
  relevantTestFileCount: number;
  noiseFilesCount: number;
  semanticScore: number;
};

export type ClusterDecisionTrace = {
  phase: "seed" | "candidate" | "rank" | "exclude" | "result";
  prNumber: number | null;
  matchedBy: ClusterMatchSource | null;
  outcome: string;
  summary: string;
  featureVector?: ClusterFeatureVector;
  reasonCodes?: ClusterReasonCode[];
  excludedReasonCode?: ClusterExcludedReasonCode;
};

export type ClusterCandidate = {
  prNumber: number;
  title: string;
  url: string;
  state: PrState;
  updatedAt: string;
  headSha: string | null;
  matchedBy: ClusterMatchSource;
  linkedIssues: number[];
  prodFiles: string[];
  testFiles: string[];
  otherFiles: string[];
  relevantProdFiles: string[];
  relevantTestFiles: string[];
  noiseFilesCount: number;
  status: ClusterCandidateStatus;
  reasonCodes: ClusterReasonCode[];
  semanticScore?: number;
  supersededBy?: number;
  reason?: string;
  featureVector: ClusterFeatureVector;
};

export type ClusterExcludedCandidate = {
  prNumber: number;
  title: string;
  url: string;
  state: PrState;
  updatedAt: string;
  matchedBy: ClusterMatchSource;
  linkedIssues: number[];
  excludedReasonCode: ClusterExcludedReasonCode;
  semanticScore?: number;
  reason: string;
  featureVector: ClusterFeatureVector;
};

export type MergeReadiness =
  | {
      state: "ready" | "needs_work" | "blocked";
      source: "review_fact";
      summary: string;
      failingTests: string[];
      commands: string[];
      headSha: string;
    }
  | {
      state: "ready" | "needs_work" | "pending" | "historical" | "unknown";
      source: "github";
      summary: string;
      failingChecks: string[];
      pendingChecks: string[];
      headSha: string | null;
      staleReviewFact?: {
        headSha: string;
        decision: ReviewFactDecision;
        recordedAt: string;
      };
    };

export type ClusterPullRequestAnalysis = {
  seedPr: {
    prNumber: number;
    title: string;
    url: string;
    state: PrState;
    updatedAt: string;
  };
  clusterBasis: "linked_issue" | "semantic_only";
  clusterIssueNumbers: number[];
  bestBase: ClusterCandidate | null;
  sameClusterCandidates: ClusterCandidate[];
  nearbyButExcluded: ClusterExcludedCandidate[];
  mergeReadiness: MergeReadiness | null;
  decisionTrace: ClusterDecisionTrace[];
};

export type IssueSearchFilters = {
  issueNumber?: number;
  labels: string[];
  state?: "open" | "closed" | "all";
  author?: string;
};

export type ParsedIssueSearchQuery = {
  raw: string;
  text: string;
  filters: IssueSearchFilters;
};

export type IssueSearchResult = {
  issueNumber: number;
  title: string;
  url: string;
  state: IssueState;
  author: string;
  labels: string[];
  updatedAt: string;
  score: number;
  matchedExcerpt: string;
};

export type SemanticQuerySourceKind = "title" | "body" | "comment";

export type SemanticDatasetSplit = "dev" | "holdout";

export type SemanticLabelSource = "bootstrap" | "review";

export type SemanticReviewAction = "reviewed" | "dropped";

export type SemanticRelevanceGrade = 1 | 2 | 3;

export type SemanticCorpusDocument = {
  docId: string;
  prNumber: number;
  docKind: SearchDocKind;
  title: string;
  text: string;
  updatedAt: string;
  state: PrState;
  author: string;
  labels: string[];
  headRef: string;
};

export type SemanticQueryRecord = {
  queryId: string;
  query: string;
  split: SemanticDatasetSplit;
  sourceKind: SemanticQuerySourceKind;
  sourceRef: string;
  sourcePrNumber: number;
  clusterKey: string;
  notes?: string;
};

export type SemanticJudgmentRecord = {
  queryId: string;
  prNumber: number;
  grade: SemanticRelevanceGrade;
  rationale: string;
  evidenceDocKind: SearchDocKind;
  evidenceRef: string;
  labelSource: SemanticLabelSource;
};

export type SemanticReviewDecisionRecord = {
  queryId: string;
  action: SemanticReviewAction;
  decidedAt: string;
  note?: string;
};

export type SemanticDatasetManifest = {
  schemaVersion: number;
  repo: string;
  createdAt: string;
  updatedAt: string;
  splits: Record<
    SemanticDatasetSplit,
    {
      queries: number;
      judgments: number;
      decisions: number;
    }
  >;
};

export type SemanticBenchmarkMetrics = {
  mrr: number;
  ndcgAt5: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  queryCount: number;
};

export type SemanticBenchmarkReport = {
  split: SemanticDatasetSplit | "all";
  mode: "fts" | "hybrid";
  overall: SemanticBenchmarkMetrics;
  bySourceKind: Partial<Record<SemanticQuerySourceKind, SemanticBenchmarkMetrics>>;
};

export type SemanticBootstrapSummary = {
  datasetPath: string;
  queryCount: number;
  judgmentCount: number;
  splitCounts: Record<SemanticDatasetSplit, number>;
};

export type SemanticReviewPreview = {
  query: SemanticQueryRecord;
  judgments: SemanticJudgmentRecord[];
  searchPreview: SearchResult[];
};

export type StatusSnapshot = {
  repo: string;
  lastSyncAt: string | null;
  lastSyncWatermark: string | null;
  issueLastSyncAt: string | null;
  issueLastSyncWatermark: string | null;
  prCount: number;
  issueCount: number;
  labelCount: number;
  issueLabelCount: number;
  commentCount: number;
  docCount: number;
  vectorEnabled: boolean;
  vectorAvailable: boolean;
  vectorError?: string;
  embeddingModel: string;
};

export type SyncSummary = {
  mode: "full" | "incremental";
  entity: "prs" | "issues";
  repo: string;
  processedPrs: number;
  processedIssues: number;
  skippedPrs: number;
  skippedIssues: number;
  docCount: number;
  commentCount: number;
  labelCount: number;
  vectorAvailable: boolean;
  lastSyncAt: string;
  lastSyncWatermark: string;
};

export type SyncProgressEvent = {
  entity: "prs" | "issues";
  phase: "discovering" | "syncing" | "complete";
  processed: number;
  skipped: number;
  queued: number;
  totalKnown: number | null;
  currentId: number | null;
  currentTitle: string | null;
};

export type PrContextBundle = {
  candidate: PriorityCandidate;
  comments: Array<{
    kind: string;
    author: string;
    createdAt: string;
    url: string;
    excerpt: string;
  }>;
  linkedIssues: IssueSearchResult[];
  relatedPullRequests: SearchResult[];
  cluster: ClusterPullRequestAnalysis | null;
  latestReviewFact: PullRequestReviewFact | null;
  mergeReadiness: MergeReadiness | null;
};

export interface PullRequestDataSource {
  listAllPullRequests(repo: RepoRef): AsyncGenerator<PullRequestRecord>;
  listChangedPullRequestNumbersSince(repo: RepoRef, since: string): Promise<number[]>;
  listChangedPullRequestsSince?(repo: RepoRef, since: string): Promise<PullRequestRecord[]>;
  getPullRequestSummary?(repo: RepoRef, prNumber: number): Promise<PullRequestRecord>;
  hydratePullRequest(repo: RepoRef, prNumber: number): Promise<HydratedPullRequest>;
  fetchPullRequestFacts?(repo: RepoRef, prNumber: number): Promise<PullRequestFactRecord>;
  getRateLimitStatus?(): Promise<{
    limit: number;
    remaining: number;
    resetAt: string;
  } | null>;
  searchPullRequestNumbers?(
    repo: RepoRef,
    query: string,
    options: { state: "open" | "closed"; limit: number },
  ): Promise<number[]>;
}

export interface IssueDataSource {
  listAllIssues(repo: RepoRef): AsyncGenerator<IssueRecord>;
  listChangedIssueNumbersSince(repo: RepoRef, since: string): Promise<number[]>;
  listChangedIssuesSince?(repo: RepoRef, since: string): Promise<IssueRecord[]>;
  getIssue(repo: RepoRef, issueNumber: number): Promise<IssueRecord>;
}
