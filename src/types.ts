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

export interface PullRequestDataSource {
  listAllPullRequests(repo: RepoRef): AsyncGenerator<PullRequestRecord>;
  listChangedPullRequestNumbersSince(repo: RepoRef, since: string): Promise<number[]>;
  hydratePullRequest(repo: RepoRef, prNumber: number): Promise<HydratedPullRequest>;
}

export interface IssueDataSource {
  listAllIssues(repo: RepoRef): AsyncGenerator<IssueRecord>;
  listChangedIssueNumbersSince(repo: RepoRef, since: string): Promise<number[]>;
  getIssue(repo: RepoRef, issueNumber: number): Promise<IssueRecord>;
}
