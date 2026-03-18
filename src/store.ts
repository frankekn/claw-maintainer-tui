import * as path from "node:path";
import { runTasksWithConcurrency } from "./lib/concurrency.js";
import { buildFtsQuery, bm25RankToScore } from "./lib/hybrid.js";
import { ensureDir, hashText } from "./lib/internal.js";
import { collectLinkedIssuesFromPrText } from "./lib/pull-request-facts.js";
import { loadSqliteVecExtension } from "./lib/sqlite-vec.js";
import { requireNodeSqlite } from "./lib/sqlite.js";
import { truncateUtf16Safe } from "./lib/text.js";
import { isoNow } from "./lib/time.js";
import {
  annotateRelevantCoverage,
  buildBestBaseReasonCodes,
  buildExcludedCandidate,
  buildLiveSemanticQueries,
  buildRelevantPathSets,
  buildSupersededReasonCodes,
  computeSemanticScore,
  rankClusterCandidates,
} from "./store/cluster-logic.js";
import {
  buildClusterDecisionTrace,
  buildClusterSeed,
  buildExcludedTrace,
  linkedIssueResultSummary,
  semanticOnlyResultSummary,
  withClusterFeatures,
} from "./store/cluster-analysis.js";
import { buildPrContextBundle } from "./store/context-bundle.js";
import { parseIssueSearchQuery, parseSearchQuery } from "./store/query.js";
import {
  buildPriorityCandidateBase as buildPriorityCandidateBaseModel,
  enrichPriorityCandidate as enrichPriorityCandidateModel,
  freshnessReason as computeFreshnessReason,
} from "./store/priority.js";
import {
  getChangedFilesForPr,
  getIssueRow,
  getLabelsForIssue,
  getLabelsForPr,
  getLinkedIssuesForPr,
  getPrRow,
  type IssueRow,
  type PrRow,
} from "./store/read-model.js";
import {
  limitRelatedPullRequests,
  rankSearchDocRows,
  type SearchDocRow,
} from "./store/search-workflow.js";
import { buildIssueFilterClause, buildPrFilterClause } from "./store/search-sql.js";
import { resolveMergeReadiness as resolveMergeReadinessModel } from "./store/merge-readiness.js";
import { syncIssuesWorkflow, syncPullRequestsWorkflow } from "./store/sync-workflow.js";
import { buildCrossReferenceQuery, normalizeSearchText, uniqueStrings } from "./store/text.js";
import { pullRequestUpsertParams, UPSERT_PULL_REQUEST_SQL } from "./store/upsert.js";
import {
  createLocalEmbeddingProvider,
  DEFAULT_GH_INTEL_LOCAL_MODEL,
  type LocalEmbeddingProvider,
} from "./embedding.js";
import type {
  AttentionState,
  ClusterCandidate,
  ClusterExcludedCandidate,
  ClusterMatchSource,
  ClusterPullRequestAnalysis,
  ClusterReasonCode,
  HydratedPullRequest,
  IssueDataSource,
  IssueRecord,
  IssueSearchFilters,
  IssueSearchResult,
  MergeReadiness,
  ParsedSearchQuery,
  PullRequestChangedFile,
  PullRequestDataSource,
  PullRequestFactRecord,
  PullRequestLinkSource,
  PullRequestLinkedIssue,
  PullRequestRecord,
  PullRequestReviewFact,
  PullRequestShowResult,
  PrContextBundle,
  PriorityCandidate,
  PriorityReason,
  PriorityAttentionState,
  ReviewFactDecision,
  RepoRef,
  SemanticCorpusDocument,
  SearchDocument,
  SearchFilters,
  SearchResult,
  SyncProgressEvent,
  StatusSnapshot,
  SyncSummary,
} from "./types.js";

const { DatabaseSync } = requireNodeSqlite();

const FTS_TABLE = "search_docs_fts";
const ISSUE_FTS_TABLE = "issues_fts";
const VECTOR_TABLE = "search_docs_vec";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const DEFAULT_SYNC_CONCURRENCY = 4;
const DEFAULT_SEARCH_LIMIT = 20;
const VECTOR_FALLBACK_WEIGHT = 0.05;
const META_LAST_SYNC_AT = "last_sync_at";
const META_LAST_SYNC_WATERMARK = "last_sync_watermark";
const META_ISSUE_LAST_SYNC_AT = "issue_last_sync_at";
const META_ISSUE_LAST_SYNC_WATERMARK = "issue_last_sync_watermark";
const META_REPO = "repo";
const META_EMBEDDING_MODEL = "embedding_model";
const META_VECTOR_DIMS = "vector_dims";
const META_DERIVED_ISSUE_LINKS_BACKFILLED_AT = "derived_issue_links_backfilled_at";
const DERIVED_LINK_SOURCES: PullRequestLinkSource[] = [
  "source_issue_marker",
  "body_reference",
  "title_reference",
];
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

type IssueDocRow = {
  issue_number: number;
  title: string;
  body: string;
  updated_at: string;
  score: number;
};

type PullRequestFactSnapshotRow = {
  pr_number: number;
  head_sha: string;
  review_decision: string | null;
  merge_state_status: string | null;
  mergeable: string | null;
  status_rollup_json: string;
  fetched_at: string;
};

type PullRequestReviewFactRow = {
  repo: string;
  pr_number: number;
  head_sha: string;
  decision: ReviewFactDecision;
  summary: string;
  commands_json: string;
  failing_tests_json: string;
  source: string;
  recorded_at: string;
};

type PrTriageStateRow = {
  repo: string;
  pr_number: number;
  attention_state: AttentionState;
  updated_at: string;
};

function toVectorBlob(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

function describeReasonCodes(codes: ClusterReasonCode[]): string {
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

function buildSearchDocuments(payload: HydratedPullRequest): SearchDocument[] {
  const docs: SearchDocument[] = [];
  const prTitle = payload.pr.title.trim();
  const prText = normalizeSearchText(
    [payload.pr.title, payload.pr.body].filter(Boolean).join("\n\n"),
  );
  if (prText) {
    docs.push({
      docId: `pr:${payload.pr.number}`,
      prNumber: payload.pr.number,
      kind: "pr_body",
      title: prTitle,
      text: prText,
      updatedAt: payload.pr.updatedAt,
      hash: hashText(prText),
    });
  }
  for (const comment of payload.comments) {
    const text = normalizeSearchText(comment.body);
    if (!text) {
      continue;
    }
    const title =
      comment.kind === "review_comment" && comment.path ? `${prTitle} (${comment.path})` : prTitle;
    docs.push({
      docId: comment.sourceId,
      prNumber: payload.pr.number,
      kind: "comment",
      title,
      text,
      updatedAt: comment.updatedAt,
      hash: hashText(text),
    });
  }
  return docs;
}

export class PrIndexStore {
  private readonly dbPath: string;
  private readonly embeddingModel: string;
  private readonly syncConcurrency: number;
  private readonly enableVector: boolean;
  private db = new DatabaseSync(":memory:");
  private provider: LocalEmbeddingProvider | null = null;
  private embeddingProviderInitPromise: Promise<LocalEmbeddingProvider | null> | null = null;
  private embeddingProviderInitAttempted = false;
  private vectorAvailable = false;
  private vectorError: string | undefined;
  private initialized = false;
  private vectorDims: number | null = null;

  constructor(params: {
    dbPath: string;
    embeddingModel?: string;
    syncConcurrency?: number;
    enableVector?: boolean;
  }) {
    this.dbPath = params.dbPath;
    this.embeddingModel = params.embeddingModel ?? DEFAULT_GH_INTEL_LOCAL_MODEL;
    this.syncConcurrency = Math.max(1, params.syncConcurrency ?? DEFAULT_SYNC_CONCURRENCY);
    this.enableVector = params.enableVector ?? true;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    ensureDir(path.dirname(this.dbPath));
    this.db = new DatabaseSync(this.dbPath, { allowExtension: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.ensureSchema();
    if (this.enableVector) {
      await this.initVector();
      this.setMeta(META_EMBEDDING_MODEL, this.embeddingModel);
    } else {
      this.vectorAvailable = false;
      this.vectorError = "disabled";
    }
    this.initialized = true;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prs (
        number INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        state TEXT NOT NULL,
        is_draft INTEGER NOT NULL DEFAULT 0,
        author TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        merged_at TEXT
      );

      CREATE TABLE IF NOT EXISTS pr_labels (
        pr_number INTEGER NOT NULL,
        label_name TEXT NOT NULL,
        PRIMARY KEY (pr_number, label_name)
      );

      CREATE TABLE IF NOT EXISTS issues (
        number INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        state TEXT NOT NULL,
        author TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS issue_labels (
        issue_number INTEGER NOT NULL,
        label_name TEXT NOT NULL,
        PRIMARY KEY (issue_number, label_name)
      );

      CREATE TABLE IF NOT EXISTS pr_comments (
        source_id TEXT PRIMARY KEY,
        pr_number INTEGER NOT NULL,
        kind TEXT NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        path TEXT,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS search_docs (
        doc_id TEXT PRIMARY KEY,
        pr_number INTEGER NOT NULL,
        doc_kind TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${EMBEDDING_CACHE_TABLE} (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, model, hash)
      );

      CREATE TABLE IF NOT EXISTS pr_fact_snapshots (
        pr_number INTEGER PRIMARY KEY,
        head_sha TEXT NOT NULL,
        review_decision TEXT,
        merge_state_status TEXT,
        mergeable TEXT,
        status_rollup_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pr_linked_issues (
        pr_number INTEGER NOT NULL,
        issue_number INTEGER NOT NULL,
        link_source TEXT NOT NULL,
        PRIMARY KEY (pr_number, issue_number, link_source)
      );

      CREATE TABLE IF NOT EXISTS pr_changed_files (
        pr_number INTEGER NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (pr_number, path)
      );

      CREATE TABLE IF NOT EXISTS pr_review_facts (
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        decision TEXT NOT NULL,
        summary TEXT NOT NULL,
        commands_json TEXT NOT NULL,
        failing_tests_json TEXT NOT NULL,
        source TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (repo, pr_number, head_sha, source)
      );

      CREATE TABLE IF NOT EXISTS pr_triage_state (
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        attention_state TEXT NOT NULL CHECK(attention_state IN ('seen', 'watch', 'ignore')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo, pr_number)
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prs_updated_at ON prs(updated_at);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prs_state ON prs(state);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prs_author ON prs(author);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prs_head_ref ON prs(head_ref);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_updated_at ON issues(updated_at);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(state);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_author ON issues(author);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pr_labels_name ON pr_labels(label_name);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_issue_labels_name ON issue_labels(label_name);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pr_comments_pr_number ON pr_comments(pr_number);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_search_docs_pr_number ON search_docs(pr_number);`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_pr_linked_issues_issue ON pr_linked_issues(issue_number);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_pr_changed_files_pr_number ON pr_changed_files(pr_number);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_pr_review_facts_pr_number ON pr_review_facts(pr_number);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_pr_triage_state_attention
         ON pr_triage_state(repo, attention_state, updated_at);`,
    );
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
        title,
        text,
        doc_id UNINDEXED,
        pr_number UNINDEXED,
        doc_kind UNINDEXED
      );`,
    );
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${ISSUE_FTS_TABLE} USING fts5(
        title,
        body,
        issue_number UNINDEXED
      );`,
    );
  }

  private async initVector(): Promise<void> {
    const result = await loadSqliteVecExtension({ db: this.db });
    this.vectorAvailable = result.ok;
    this.vectorError = result.error;
    const dims = this.getMeta(META_VECTOR_DIMS);
    if (dims) {
      this.vectorDims = Number(dims);
    }
    if (this.vectorAvailable && this.vectorDims) {
      this.ensureVectorTable(this.vectorDims);
    }
  }

  private async ensureEmbeddingProvider(): Promise<LocalEmbeddingProvider | null> {
    if (!this.enableVector || !this.vectorAvailable) {
      return null;
    }
    if (this.provider) {
      return this.provider;
    }
    if (this.embeddingProviderInitAttempted) {
      return null;
    }
    if (!this.embeddingProviderInitPromise) {
      this.embeddingProviderInitPromise = (async () => {
        try {
          const provider = await createLocalEmbeddingProvider(this.embeddingModel);
          this.provider = provider;
          return provider;
        } catch (error) {
          this.provider = null;
          this.vectorError = error instanceof Error ? error.message : String(error);
          return null;
        } finally {
          this.embeddingProviderInitAttempted = true;
          this.embeddingProviderInitPromise = null;
        }
      })();
    }
    return this.embeddingProviderInitPromise;
  }

  private ensureVectorTable(dimensions: number): void {
    if (!this.vectorAvailable) {
      return;
    }
    if (this.vectorDims && this.vectorDims !== dimensions) {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${dimensions}]
      )`,
    );
    this.vectorDims = dimensions;
    this.setMeta(META_VECTOR_DIMS, String(dimensions));
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private clearIssueLinksForSources(prNumber: number, sources: PullRequestLinkSource[]): void {
    if (sources.length === 0) {
      return;
    }
    const placeholders = sources.map(() => "?").join(", ");
    this.db
      .prepare(
        `DELETE FROM pr_linked_issues WHERE pr_number = ? AND link_source IN (${placeholders})`,
      )
      .run(prNumber, ...sources);
  }

  private upsertDerivedIssueLinksForPr(prNumber: number, title: string, body: string): void {
    this.clearIssueLinksForSources(prNumber, DERIVED_LINK_SOURCES);
    for (const issue of collectLinkedIssuesFromPrText(title, body)) {
      this.db
        .prepare(
          `INSERT INTO pr_linked_issues (pr_number, issue_number, link_source) VALUES (?, ?, ?)`,
        )
        .run(prNumber, issue.issueNumber, issue.linkSource);
    }
  }

  async ensureDerivedIssueLinksBackfilled(): Promise<void> {
    await this.init();
    if (this.getMeta(META_DERIVED_ISSUE_LINKS_BACKFILLED_AT)) {
      return;
    }
    const rows = this.db.prepare("SELECT number, title, body FROM prs").all() as Array<{
      number: number;
      title: string;
      body: string;
    }>;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `DELETE FROM pr_linked_issues WHERE link_source IN (${DERIVED_LINK_SOURCES.map(() => "?").join(", ")})`,
        )
        .run(...DERIVED_LINK_SOURCES);
      for (const row of rows) {
        this.upsertDerivedIssueLinksForPr(row.number, row.title, row.body);
      }
      this.setMeta(META_DERIVED_ISSUE_LINKS_BACKFILLED_AT, isoNow());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async recordPullRequestFacts(facts: PullRequestFactRecord): Promise<void> {
    await this.init();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO pr_fact_snapshots (
            pr_number, head_sha, review_decision, merge_state_status, mergeable,
            status_rollup_json, fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(pr_number) DO UPDATE SET
            head_sha = excluded.head_sha,
            review_decision = excluded.review_decision,
            merge_state_status = excluded.merge_state_status,
            mergeable = excluded.mergeable,
            status_rollup_json = excluded.status_rollup_json,
            fetched_at = excluded.fetched_at`,
        )
        .run(
          facts.prNumber,
          facts.headSha,
          facts.reviewDecision,
          facts.mergeStateStatus,
          facts.mergeable,
          JSON.stringify(facts.statusChecks),
          facts.fetchedAt,
        );
      this.clearIssueLinksForSources(facts.prNumber, ["closing_reference"]);
      for (const issue of facts.linkedIssues) {
        this.db
          .prepare(
            `INSERT INTO pr_linked_issues (pr_number, issue_number, link_source) VALUES (?, ?, ?)
             ON CONFLICT(pr_number, issue_number, link_source) DO NOTHING`,
          )
          .run(facts.prNumber, issue.issueNumber, issue.linkSource);
      }
      this.db.prepare("DELETE FROM pr_changed_files WHERE pr_number = ?").run(facts.prNumber);
      for (const file of facts.changedFiles) {
        this.db
          .prepare(`INSERT INTO pr_changed_files (pr_number, path, kind) VALUES (?, ?, ?)`)
          .run(facts.prNumber, file.path, file.kind);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getPullRequestFacts(prNumber: number): Promise<PullRequestFactRecord | null> {
    await this.init();
    const snapshot = this.db
      .prepare(
        `SELECT pr_number, head_sha, review_decision, merge_state_status, mergeable, status_rollup_json, fetched_at
           FROM pr_fact_snapshots
          WHERE pr_number = ?`,
      )
      .get(prNumber) as PullRequestFactSnapshotRow | undefined;
    if (!snapshot) {
      return null;
    }
    const linkedIssues = this.db
      .prepare(
        `SELECT issue_number, link_source FROM pr_linked_issues WHERE pr_number = ? ORDER BY issue_number ASC, link_source ASC`,
      )
      .all(prNumber) as Array<{ issue_number: number; link_source: PullRequestLinkSource }>;
    const changedFiles = this.db
      .prepare(`SELECT path, kind FROM pr_changed_files WHERE pr_number = ? ORDER BY path ASC`)
      .all(prNumber) as Array<{ path: string; kind: PullRequestChangedFile["kind"] }>;
    return {
      prNumber: snapshot.pr_number,
      headSha: snapshot.head_sha,
      reviewDecision: snapshot.review_decision,
      mergeStateStatus: snapshot.merge_state_status,
      mergeable: snapshot.mergeable,
      statusChecks: JSON.parse(
        snapshot.status_rollup_json,
      ) as PullRequestFactRecord["statusChecks"],
      linkedIssues: linkedIssues.map((issue) => ({
        issueNumber: issue.issue_number,
        linkSource: issue.link_source,
      })),
      changedFiles: changedFiles.map((file) => ({ path: file.path, kind: file.kind })),
      fetchedAt: snapshot.fetched_at,
    };
  }

  async recordReviewFact(fact: PullRequestReviewFact): Promise<void> {
    await this.init();
    this.db
      .prepare(
        `INSERT INTO pr_review_facts (
          repo, pr_number, head_sha, decision, summary, commands_json, failing_tests_json, source, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo, pr_number, head_sha, source) DO UPDATE SET
          decision = excluded.decision,
          summary = excluded.summary,
          commands_json = excluded.commands_json,
          failing_tests_json = excluded.failing_tests_json,
          recorded_at = excluded.recorded_at`,
      )
      .run(
        fact.repo,
        fact.prNumber,
        fact.headSha,
        fact.decision,
        fact.summary,
        JSON.stringify(fact.commands),
        JSON.stringify(fact.failingTests),
        fact.source,
        fact.recordedAt,
      );
  }

  private getLatestReviewFact(prNumber: number, repo: string): PullRequestReviewFact | null {
    const row = this.db
      .prepare(
        `SELECT repo, pr_number, head_sha, decision, summary, commands_json, failing_tests_json, source, recorded_at
           FROM pr_review_facts
          WHERE repo = ? AND pr_number = ?
          ORDER BY recorded_at DESC
          LIMIT 1`,
      )
      .get(repo, prNumber) as PullRequestReviewFactRow | undefined;
    if (!row) {
      return null;
    }
    return {
      repo: row.repo,
      prNumber: row.pr_number,
      headSha: row.head_sha,
      decision: row.decision,
      summary: row.summary,
      commands: JSON.parse(row.commands_json) as string[],
      failingTests: JSON.parse(row.failing_tests_json) as string[],
      source: row.source,
      recordedAt: row.recorded_at,
    };
  }

  private repoKey(repo: RepoRef | string): string {
    return typeof repo === "string" ? repo : `${repo.owner}/${repo.name}`;
  }

  private getAttentionState(repo: string, prNumber: number): PriorityAttentionState {
    const row = this.db
      .prepare(
        `SELECT attention_state
           FROM pr_triage_state
          WHERE repo = ? AND pr_number = ?`,
      )
      .get(repo, prNumber) as Pick<PrTriageStateRow, "attention_state"> | undefined;
    return row?.attention_state ?? "new";
  }

  private buildSearchResultFromPrRow(pr: PrRow, score: number): SearchResult {
    return {
      prNumber: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      author: pr.author,
      labels: this.getLabelsForPr(pr.number),
      updatedAt: pr.updated_at,
      score,
      matchedDocKind: "pr_body",
      matchedExcerpt: truncateUtf16Safe(normalizeSearchText(pr.body || pr.title), 280),
    };
  }

  private freshnessReason(updatedAt: string): PriorityReason | null {
    return computeFreshnessReason(updatedAt);
  }

  private buildPriorityCandidateBase(pr: PrRow, repo: string): PriorityCandidate {
    const attentionState = this.getAttentionState(repo, pr.number);
    const labels = this.getLabelsForPr(pr.number);
    return buildPriorityCandidateBaseModel({
      pr: this.buildSearchResultFromPrRow(pr, 0),
      attentionState,
      labels,
      isDraft: Boolean(pr.is_draft),
    });
  }

  private async enrichPriorityCandidate(
    candidate: PriorityCandidate,
    options: { relatedLimit?: number; clusterLimit?: number } = {},
  ): Promise<PriorityCandidate> {
    const linkedIssues = this.getLinkedIssuesForPr(candidate.pr.prNumber);
    const relatedPullRequests = await this.findRelatedPullRequests(
      candidate.pr.prNumber,
      options.relatedLimit ?? 5,
      { ftsOnly: true },
    );
    const cluster = await this.clusterPullRequest({
      prNumber: candidate.pr.prNumber,
      limit: options.clusterLimit ?? 5,
      ftsOnly: true,
    });
    const relatedNumbers = new Set<number>(relatedPullRequests.map((pr) => pr.prNumber));
    for (const clusterCandidate of cluster?.sameClusterCandidates ?? []) {
      relatedNumbers.add(clusterCandidate.prNumber);
    }
    relatedNumbers.delete(candidate.pr.prNumber);

    return enrichPriorityCandidateModel({
      candidate,
      linkedIssueCount: linkedIssues.length,
      relatedPullRequestCount: relatedNumbers.size,
    });
  }

  private getStoredUpdatedAt(prNumber: number): string | null {
    const row = this.db.prepare("SELECT updated_at FROM prs WHERE number = ?").get(prNumber) as
      | { updated_at: string }
      | undefined;
    return row?.updated_at ?? null;
  }

  private getStoredIssueUpdatedAt(issueNumber: number): string | null {
    const row = this.db
      .prepare("SELECT updated_at FROM issues WHERE number = ?")
      .get(issueNumber) as { updated_at: string } | undefined;
    return row?.updated_at ?? null;
  }

  private collectCachedEmbeddings(hashes: string[]): Map<string, number[]> {
    if (hashes.length === 0) {
      return new Map();
    }
    const placeholders = hashes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE} WHERE provider = ? AND model = ? AND hash IN (${placeholders})`,
      )
      .all("local", this.embeddingModel, ...hashes) as Array<{
      hash: string;
      embedding: string;
    }>;
    const out = new Map<string, number[]>();
    for (const row of rows) {
      out.set(row.hash, JSON.parse(row.embedding) as number[]);
    }
    return out;
  }

  private async embedDocuments(docs: SearchDocument[]): Promise<Map<string, number[]>> {
    const byHash = this.collectCachedEmbeddings(docs.map((doc) => doc.hash));
    if (!this.vectorAvailable) {
      return byHash;
    }
    const provider = await this.ensureEmbeddingProvider();
    if (!provider) {
      return byHash;
    }
    const missing = docs.filter((doc) => !byHash.has(doc.hash));
    if (missing.length === 0) {
      return byHash;
    }
    try {
      const vectors = await provider.embedBatch(missing.map((doc) => doc.text));
      const timestamp = isoNow();
      for (let index = 0; index < missing.length; index += 1) {
        const doc = missing[index]!;
        const embedding = vectors[index] ?? [];
        if (embedding.length === 0) {
          continue;
        }
        byHash.set(doc.hash, embedding);
        this.db
          .prepare(
            `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, hash, embedding, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(provider, model, hash) DO UPDATE SET embedding = excluded.embedding, updated_at = excluded.updated_at`,
          )
          .run("local", this.embeddingModel, doc.hash, JSON.stringify(embedding), timestamp);
      }
    } catch (error) {
      this.vectorError = error instanceof Error ? error.message : String(error);
      this.vectorAvailable = false;
    }
    return byHash;
  }

  private getAllSearchDocuments(): SearchDocument[] {
    const rows = this.db
      .prepare("SELECT * FROM search_docs ORDER BY updated_at DESC, doc_id ASC")
      .all() as Array<{
      doc_id: string;
      pr_number: number;
      doc_kind: "pr_body" | "comment";
      title: string;
      text: string;
      updated_at: string;
      hash: string;
    }>;
    return rows.map((row) => ({
      docId: row.doc_id,
      prNumber: row.pr_number,
      kind: row.doc_kind,
      title: row.title,
      text: row.text,
      updatedAt: row.updated_at,
      hash: row.hash,
    }));
  }

  private async ensureVectorIndex(): Promise<void> {
    if (!this.vectorAvailable) {
      return;
    }
    const docs = this.getAllSearchDocuments();
    if (docs.length === 0) {
      return;
    }
    if (this.vectorDims && this.countRows(VECTOR_TABLE) >= docs.length) {
      return;
    }
    const docEmbeddings = await this.embedDocuments(docs);
    const sampleEmbedding = docEmbeddings.values().next().value as number[] | undefined;
    if (!sampleEmbedding?.length) {
      return;
    }
    this.ensureVectorTable(sampleEmbedding.length);

    this.db.exec("BEGIN");
    try {
      this.db.exec(`DELETE FROM ${VECTOR_TABLE}`);
      for (const doc of docs) {
        const embedding = docEmbeddings.get(doc.hash);
        if (!embedding?.length) {
          continue;
        }
        this.db
          .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
          .run(doc.docId, toVectorBlob(embedding));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private upsertIssue(issue: IssueRecord): void {
    const title = issue.title.trim();
    const body = normalizeSearchText(issue.body);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO issues (
            number, title, body, state, author, url, created_at, updated_at, closed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(number) DO UPDATE SET
            title = excluded.title,
            body = excluded.body,
            state = excluded.state,
            author = excluded.author,
            url = excluded.url,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            closed_at = excluded.closed_at`,
        )
        .run(
          issue.number,
          title,
          body,
          issue.state,
          issue.author,
          issue.url,
          issue.createdAt,
          issue.updatedAt,
          issue.closedAt,
        );

      this.db.prepare("DELETE FROM issue_labels WHERE issue_number = ?").run(issue.number);
      for (const label of issue.labels) {
        this.db
          .prepare("INSERT INTO issue_labels (issue_number, label_name) VALUES (?, ?)")
          .run(issue.number, label);
      }

      this.db.prepare(`DELETE FROM ${ISSUE_FTS_TABLE} WHERE issue_number = ?`).run(issue.number);
      this.db
        .prepare(
          `INSERT INTO ${ISSUE_FTS_TABLE} (title, body, issue_number)
           VALUES (?, ?, ?)`,
        )
        .run(title, body, issue.number);

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private upsertPullRequestSummary(pr: PullRequestRecord): void {
    const existing = this.db
      .prepare(
        `SELECT state, is_draft, base_ref, head_ref, url, closed_at, merged_at
           FROM prs
          WHERE number = ?`,
      )
      .get(pr.number) as
      | {
          state: PullRequestRecord["state"];
          is_draft: number;
          base_ref: string;
          head_ref: string;
          url: string;
          closed_at: string | null;
          merged_at: string | null;
        }
      | undefined;
    const mergedState = pr.state === "closed" && existing?.state === "merged" ? "merged" : pr.state;
    const preserved = {
      isDraft: existing ? Boolean(existing.is_draft) : pr.isDraft,
      baseRef: pr.baseRef || existing?.base_ref || "",
      headRef: pr.headRef || existing?.head_ref || "",
      url: pr.url || existing?.url || "",
      closedAt: pr.closedAt ?? existing?.closed_at ?? null,
      mergedAt: pr.mergedAt ?? existing?.merged_at ?? null,
    };
    const mergedRecord: PullRequestRecord = {
      ...pr,
      state: mergedState,
      ...preserved,
    };
    const docs = buildSearchDocuments({ pr: mergedRecord, comments: [] });
    const prDoc = docs.find((doc) => doc.kind === "pr_body") ?? null;

    this.db.exec("BEGIN");
    try {
      this.db.prepare(UPSERT_PULL_REQUEST_SQL).run(...pullRequestUpsertParams(mergedRecord));

      this.upsertDerivedIssueLinksForPr(mergedRecord.number, mergedRecord.title, mergedRecord.body);

      this.db.prepare("DELETE FROM pr_labels WHERE pr_number = ?").run(mergedRecord.number);
      for (const label of mergedRecord.labels) {
        this.db
          .prepare("INSERT INTO pr_labels (pr_number, label_name) VALUES (?, ?)")
          .run(mergedRecord.number, label);
      }

      this.db.prepare("DELETE FROM search_docs WHERE doc_id = ?").run(`pr:${mergedRecord.number}`);
      this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE doc_id = ?`).run(`pr:${mergedRecord.number}`);
      if (this.vectorDims) {
        this.db
          .prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`)
          .run(`pr:${mergedRecord.number}`);
      }

      if (prDoc) {
        this.db
          .prepare(
            `INSERT INTO search_docs (doc_id, pr_number, doc_kind, title, text, updated_at, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            prDoc.docId,
            prDoc.prNumber,
            prDoc.kind,
            prDoc.title,
            prDoc.text,
            prDoc.updatedAt,
            prDoc.hash,
          );
        this.db
          .prepare(
            `INSERT INTO ${FTS_TABLE} (title, text, doc_id, pr_number, doc_kind)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(prDoc.title, prDoc.text, prDoc.docId, prDoc.prNumber, prDoc.kind);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private upsertHydratedPullRequest(
    payload: HydratedPullRequest,
    options: { indexVectors?: boolean } = {},
  ): Promise<void> {
    return (async () => {
      const docs = buildSearchDocuments(payload);
      const indexVectors = options.indexVectors ?? true;
      const docEmbeddings = indexVectors
        ? await this.embedDocuments(docs)
        : new Map<string, number[]>();
      const sampleEmbedding = docEmbeddings.values().next().value as number[] | undefined;
      if (sampleEmbedding?.length) {
        this.ensureVectorTable(sampleEmbedding.length);
      }

      this.db.exec("BEGIN");
      try {
        this.db.prepare(UPSERT_PULL_REQUEST_SQL).run(...pullRequestUpsertParams(payload.pr));

        this.upsertDerivedIssueLinksForPr(payload.pr.number, payload.pr.title, payload.pr.body);

        this.db.prepare("DELETE FROM pr_labels WHERE pr_number = ?").run(payload.pr.number);
        for (const label of payload.pr.labels) {
          this.db
            .prepare("INSERT INTO pr_labels (pr_number, label_name) VALUES (?, ?)")
            .run(payload.pr.number, label);
        }

        this.db.prepare("DELETE FROM pr_comments WHERE pr_number = ?").run(payload.pr.number);
        for (const comment of payload.comments) {
          this.db
            .prepare(
              `INSERT INTO pr_comments (
                source_id, pr_number, kind, author, body, path, url, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              comment.sourceId,
              payload.pr.number,
              comment.kind,
              comment.author,
              comment.body,
              comment.path,
              comment.url,
              comment.createdAt,
              comment.updatedAt,
            );
        }

        const existingDocIds = this.db
          .prepare("SELECT doc_id FROM search_docs WHERE pr_number = ?")
          .all(payload.pr.number) as Array<{ doc_id: string }>;
        if (existingDocIds.length > 0) {
          const ids = existingDocIds.map((row) => row.doc_id);
          const placeholders = ids.map(() => "?").join(", ");
          this.db.prepare(`DELETE FROM search_docs WHERE doc_id IN (${placeholders})`).run(...ids);
          this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE doc_id IN (${placeholders})`).run(...ids);
          if (this.vectorDims) {
            this.db
              .prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id IN (${placeholders})`)
              .run(...ids);
          }
        }

        for (const doc of docs) {
          this.db
            .prepare(
              `INSERT INTO search_docs (doc_id, pr_number, doc_kind, title, text, updated_at, hash)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(doc.docId, doc.prNumber, doc.kind, doc.title, doc.text, doc.updatedAt, doc.hash);
          this.db
            .prepare(
              `INSERT INTO ${FTS_TABLE} (title, text, doc_id, pr_number, doc_kind)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(doc.title, doc.text, doc.docId, doc.prNumber, doc.kind);

          if (indexVectors && this.vectorAvailable && this.vectorDims) {
            const embedding = docEmbeddings.get(doc.hash);
            if (embedding?.length) {
              this.db
                .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
                .run(doc.docId, toVectorBlob(embedding));
            }
          }
        }

        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    })();
  }

  async sync(params: {
    repo: RepoRef;
    source: PullRequestDataSource;
    full?: boolean;
    hydrateAll?: boolean;
    onProgress?: (event: SyncProgressEvent) => void;
  }): Promise<SyncSummary> {
    await this.init();
    const repoName = `${params.repo.owner}/${params.repo.name}`;
    return syncPullRequestsWorkflow({
      ...params,
      syncConcurrency: this.syncConcurrency,
      lastSyncWatermark: this.getMeta(META_LAST_SYNC_WATERMARK),
      repoName,
      vectorAvailable: this.vectorAvailable,
      getStoredUpdatedAt: (prNumber) => this.getStoredUpdatedAt(prNumber),
      upsertHydratedPullRequest: (payload, options) =>
        this.upsertHydratedPullRequest(payload, options),
      upsertPullRequestSummary: (pr) => this.upsertPullRequestSummary(pr),
      setMeta: (key, value) => this.setMeta(key, value),
      countRows: (table) => this.countRows(table),
      metaKeys: {
        repo: META_REPO,
        lastSyncAt: META_LAST_SYNC_AT,
        lastSyncWatermark: META_LAST_SYNC_WATERMARK,
      },
    });
  }

  async syncIssues(params: {
    repo: RepoRef;
    source: IssueDataSource;
    full?: boolean;
    onProgress?: (event: SyncProgressEvent) => void;
  }): Promise<SyncSummary> {
    await this.init();
    const repoName = `${params.repo.owner}/${params.repo.name}`;
    return syncIssuesWorkflow({
      ...params,
      syncConcurrency: this.syncConcurrency,
      lastSyncWatermark: this.getMeta(META_ISSUE_LAST_SYNC_WATERMARK),
      repoName,
      vectorAvailable: this.vectorAvailable,
      getStoredIssueUpdatedAt: (issueNumber) => this.getStoredIssueUpdatedAt(issueNumber),
      upsertIssue: (issue) => this.upsertIssue(issue),
      setMeta: (key, value) => this.setMeta(key, value),
      countRows: (table) => this.countRows(table),
      metaKeys: {
        repo: META_REPO,
        lastSyncAt: META_ISSUE_LAST_SYNC_AT,
        lastSyncWatermark: META_ISSUE_LAST_SYNC_WATERMARK,
      },
    });
  }

  private countRows(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }

  async setPrAttentionState(
    repo: RepoRef | string,
    prNumber: number,
    state: AttentionState | null,
  ): Promise<void> {
    await this.init();
    const repoKey = this.repoKey(repo);
    if (state === null) {
      this.db
        .prepare(`DELETE FROM pr_triage_state WHERE repo = ? AND pr_number = ?`)
        .run(repoKey, prNumber);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO pr_triage_state (repo, pr_number, attention_state, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo, pr_number) DO UPDATE SET
           attention_state = excluded.attention_state,
           updated_at = excluded.updated_at`,
      )
      .run(repoKey, prNumber, state, isoNow());
  }

  async listPriorityQueue(params: {
    repo: RepoRef | string;
    limit: number;
    scanLimit?: number;
  }): Promise<PriorityCandidate[]> {
    await this.init();
    await this.ensureDerivedIssueLinksBackfilled();
    const repoKey = this.repoKey(params.repo);
    const scanLimit = Math.max(params.limit, params.scanLimit ?? 300);
    const recentOpen = this.db
      .prepare(
        `SELECT *
           FROM prs
          WHERE state = 'open'
          ORDER BY updated_at DESC, number DESC
          LIMIT ?`,
      )
      .all(scanLimit) as PrRow[];
    const watchedOpen = this.db
      .prepare(
        `SELECT p.*
           FROM prs p
           JOIN pr_triage_state t
             ON t.repo = ?
            AND t.pr_number = p.number
          WHERE p.state = 'open'
            AND t.attention_state = 'watch'
          ORDER BY p.updated_at DESC, p.number DESC`,
      )
      .all(repoKey) as PrRow[];

    const byNumber = new Map<number, PrRow>();
    for (const row of recentOpen) {
      byNumber.set(row.number, row);
    }
    for (const row of watchedOpen) {
      byNumber.set(row.number, row);
    }

    const baseline = Array.from(byNumber.values())
      .map((row) => this.buildPriorityCandidateBase(row, repoKey))
      .filter((candidate) => candidate.attentionState !== "ignore")
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.pr.updatedAt.localeCompare(left.pr.updatedAt) ||
          right.pr.prNumber - left.pr.prNumber,
      );

    const topForEnrichment = baseline.slice(0, Math.min(80, baseline.length));
    const enriched = new Map<number, PriorityCandidate>();
    const result = await runTasksWithConcurrency({
      tasks: topForEnrichment.map((candidate) => async () => {
        enriched.set(candidate.pr.prNumber, await this.enrichPriorityCandidate(candidate));
        return candidate.pr.prNumber;
      }),
      limit: 6,
      errorMode: "stop",
    });
    if (result.hasError) {
      throw result.firstError;
    }

    return baseline
      .map((candidate) => enriched.get(candidate.pr.prNumber) ?? candidate)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.pr.updatedAt.localeCompare(left.pr.updatedAt) ||
          right.pr.prNumber - left.pr.prNumber,
      )
      .slice(0, params.limit);
  }

  async listWatchlist(
    repo: RepoRef | string,
    limit = DEFAULT_SEARCH_LIMIT,
  ): Promise<PriorityCandidate[]> {
    await this.init();
    await this.ensureDerivedIssueLinksBackfilled();
    const repoKey = this.repoKey(repo);
    const rows = this.db
      .prepare(
        `SELECT p.*
           FROM prs p
           JOIN pr_triage_state t
             ON t.repo = ?
            AND t.pr_number = p.number
          WHERE p.state = 'open'
            AND t.attention_state = 'watch'
          ORDER BY p.updated_at DESC, p.number DESC
          LIMIT ?`,
      )
      .all(repoKey, limit) as PrRow[];
    const result = await runTasksWithConcurrency({
      tasks: rows.map(
        (row) => async () =>
          this.enrichPriorityCandidate(this.buildPriorityCandidateBase(row, repoKey)),
      ),
      limit: 6,
      errorMode: "stop",
    });
    if (result.hasError) {
      throw result.firstError;
    }
    return result.results
      .filter((value): value is PriorityCandidate => Boolean(value))
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.pr.updatedAt.localeCompare(left.pr.updatedAt) ||
          right.pr.prNumber - left.pr.prNumber,
      );
  }

  async getPrContextBundle(
    repo: RepoRef | string,
    prNumber: number,
  ): Promise<PrContextBundle | null> {
    await this.init();
    await this.ensureDerivedIssueLinksBackfilled();
    const repoKey = this.repoKey(repo);
    const pr = this.getPrRow(prNumber);
    if (!pr) {
      return null;
    }
    const payload = await this.show(prNumber);
    const candidate = await this.enrichPriorityCandidate(
      this.buildPriorityCandidateBase(pr, repoKey),
    );
    const linkedIssues = this.getLinkedIssuesForPr(prNumber)
      .map((issue) => this.getIssueRow(issue.issueNumber))
      .filter((issue): issue is IssueRow => Boolean(issue))
      .map((issue) => ({
        issueNumber: issue.number,
        title: issue.title,
        url: issue.url,
        state: issue.state,
        author: issue.author,
        labels: this.getLabelsForIssue(issue.number),
        updatedAt: issue.updated_at,
        score: 1,
        matchedExcerpt: truncateUtf16Safe(normalizeSearchText(issue.body || issue.title), 280),
      }));
    const cluster = await this.clusterPullRequest({
      prNumber,
      limit: 5,
      ftsOnly: true,
    });
    const relatedPullRequests = new Map<number, SearchResult>();
    for (const relatedPullRequest of await this.findRelatedPullRequests(prNumber, 5, {
      ftsOnly: true,
    })) {
      relatedPullRequests.set(relatedPullRequest.prNumber, relatedPullRequest);
    }
    for (const clusterCandidate of cluster?.sameClusterCandidates ?? []) {
      if (clusterCandidate.prNumber === prNumber) {
        continue;
      }
      if (relatedPullRequests.has(clusterCandidate.prNumber)) {
        continue;
      }
      const clusterPr = this.getPrRow(clusterCandidate.prNumber);
      if (!clusterPr) {
        continue;
      }
      relatedPullRequests.set(
        clusterCandidate.prNumber,
        this.buildSearchResultFromPrRow(clusterPr, clusterCandidate.semanticScore ?? 1),
      );
    }
    return buildPrContextBundle({
      candidate,
      payload,
      linkedIssues,
      relatedPullRequests: relatedPullRequests.values(),
      cluster,
      latestReviewFact: this.getLatestReviewFact(prNumber, repoKey),
      mergeReadiness: this.resolveMergeReadiness(
        this.buildClusterCandidate(prNumber, "same_cluster_candidate", "linked_issue"),
      ),
    });
  }

  async search(rawQuery: string, limit = DEFAULT_SEARCH_LIMIT): Promise<SearchResult[]> {
    await this.init();
    const parsed = parseSearchQuery(rawQuery);
    return this.searchParsed(parsed, limit);
  }

  private async searchParsed(
    parsed: ParsedSearchQuery,
    limit: number,
    options: { ftsOnly?: boolean } = {},
  ): Promise<SearchResult[]> {
    if (!parsed.text) {
      return this.searchByFiltersOnly(parsed.filters, limit);
    }

    const keywordHits = this.searchKeywordDocs(parsed, limit * 5);
    const vectorHits = options.ftsOnly ? [] : await this.searchVectorDocs(parsed, limit * 5);
    const ranked = rankSearchDocRows({
      keywordHits,
      vectorHits,
      vectorFallbackWeight: VECTOR_FALLBACK_WEIGHT,
    });

    const seen = new Set<number>();
    const results: SearchResult[] = [];
    for (const row of ranked) {
      if (seen.has(row.pr_number)) {
        continue;
      }
      const pr = this.getPrRow(row.pr_number);
      if (!pr) {
        continue;
      }
      seen.add(row.pr_number);
      results.push({
        prNumber: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        author: pr.author,
        labels: this.getLabelsForPr(pr.number),
        updatedAt: pr.updated_at,
        score: row.score,
        matchedDocKind: row.doc_kind,
        matchedExcerpt: truncateUtf16Safe(row.text, 280),
      });
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  async findRelatedPullRequests(
    prNumber: number,
    limit = DEFAULT_SEARCH_LIMIT,
    options: { ftsOnly?: boolean } = {},
  ): Promise<SearchResult[]> {
    await this.init();
    const payload = await this.show(prNumber);
    if (!payload.pr) {
      return [];
    }
    const query = buildCrossReferenceQuery(payload.pr.title, payload.pr.matchedExcerpt);
    const results = await this.searchParsed(parseSearchQuery(query), limit + 1, options);
    return limitRelatedPullRequests(results, prNumber, limit);
  }

  async searchIssues(rawQuery: string, limit = DEFAULT_SEARCH_LIMIT): Promise<IssueSearchResult[]> {
    await this.init();
    const parsed = parseIssueSearchQuery(rawQuery);
    if (!parsed.text) {
      return this.searchIssuesByFiltersOnly(parsed.filters, limit);
    }

    const ftsQuery = buildFtsQuery(parsed.text);
    if (!ftsQuery) {
      return this.searchIssuesByFiltersOnly(parsed.filters, limit);
    }
    const filter = buildIssueFilterClause(parsed.filters, "i");
    const rows = this.db
      .prepare(
        `SELECT i.number AS issue_number, i.title, i.body, i.updated_at,
                bm25(${ISSUE_FTS_TABLE}) AS rank
           FROM ${ISSUE_FTS_TABLE}
           JOIN issues i ON i.number = ${ISSUE_FTS_TABLE}.issue_number
          WHERE ${ISSUE_FTS_TABLE} MATCH ?${filter.sql ? ` AND ${filter.sql.slice(7)}` : ""}
          ORDER BY rank ASC
          LIMIT ?`,
      )
      .all(ftsQuery, ...filter.params, limit) as Array<{
      issue_number: number;
      title: string;
      body: string;
      updated_at: string;
      rank: number;
    }>;

    return rows.map((row) => {
      const issue = this.getIssueRow(row.issue_number);
      if (!issue) {
        throw new Error(`missing issue row for ${row.issue_number}`);
      }
      return {
        issueNumber: issue.number,
        title: issue.title,
        url: issue.url,
        state: issue.state,
        author: issue.author,
        labels: this.getLabelsForIssue(issue.number),
        updatedAt: issue.updated_at,
        score: bm25RankToScore(row.rank),
        matchedExcerpt: truncateUtf16Safe(normalizeSearchText(issue.body || issue.title), 280),
      };
    });
  }

  private searchByFiltersOnly(filters: SearchFilters, limit: number): SearchResult[] {
    const filter = buildPrFilterClause(filters, "p");
    const rows = this.db
      .prepare(`SELECT p.* FROM prs p${filter.sql} ORDER BY p.updated_at DESC LIMIT ?`)
      .all(...filter.params, limit) as PrRow[];
    return rows.map((row) => ({
      prNumber: row.number,
      title: row.title,
      url: row.url,
      state: row.state,
      author: row.author,
      labels: this.getLabelsForPr(row.number),
      updatedAt: row.updated_at,
      score: 1,
      matchedDocKind: "pr_body",
      matchedExcerpt: truncateUtf16Safe(normalizeSearchText(row.body || row.title), 280),
    }));
  }

  private searchIssuesByFiltersOnly(
    filters: IssueSearchFilters,
    limit: number,
  ): IssueSearchResult[] {
    const filter = buildIssueFilterClause(filters, "i");
    const rows = this.db
      .prepare(`SELECT i.* FROM issues i${filter.sql} ORDER BY i.updated_at DESC LIMIT ?`)
      .all(...filter.params, limit) as IssueRow[];
    return rows.map((row) => ({
      issueNumber: row.number,
      title: row.title,
      url: row.url,
      state: row.state,
      author: row.author,
      labels: this.getLabelsForIssue(row.number),
      updatedAt: row.updated_at,
      score: 1,
      matchedExcerpt: truncateUtf16Safe(normalizeSearchText(row.body || row.title), 280),
    }));
  }

  private searchKeywordDocs(parsed: ParsedSearchQuery, limit: number): SearchDocRow[] {
    const ftsQuery = buildFtsQuery(parsed.text);
    if (!ftsQuery) {
      return [];
    }
    const filter = buildPrFilterClause(parsed.filters, "p");
    const rows = this.db
      .prepare(
        `SELECT d.doc_id, d.pr_number, d.doc_kind, d.title, d.text, d.updated_at,
                bm25(${FTS_TABLE}) AS rank
           FROM ${FTS_TABLE}
           JOIN search_docs d ON d.doc_id = ${FTS_TABLE}.doc_id
           JOIN prs p ON p.number = d.pr_number
          WHERE ${FTS_TABLE} MATCH ?${filter.sql ? ` AND ${filter.sql.slice(7)}` : ""}
          ORDER BY rank ASC
          LIMIT ?`,
      )
      .all(ftsQuery, ...filter.params, limit) as Array<{
      doc_id: string;
      pr_number: number;
      doc_kind: "pr_body" | "comment";
      title: string;
      text: string;
      updated_at: string;
      rank: number;
    }>;

    return rows.map((row) => ({
      doc_id: row.doc_id,
      pr_number: row.pr_number,
      doc_kind: row.doc_kind,
      title: row.title,
      text: row.text,
      updated_at: row.updated_at,
      score: bm25RankToScore(row.rank),
    }));
  }

  private async searchVectorDocs(
    parsed: ParsedSearchQuery,
    limit: number,
  ): Promise<SearchDocRow[]> {
    if (!this.vectorAvailable) {
      return [];
    }
    await this.ensureVectorIndex();
    if (!this.vectorDims) {
      return [];
    }
    const provider = await this.ensureEmbeddingProvider();
    if (!provider) {
      return [];
    }
    let queryVec: number[];
    try {
      queryVec = await provider.embedQuery(parsed.text);
    } catch (error) {
      this.vectorError = error instanceof Error ? error.message : String(error);
      return [];
    }
    if (queryVec.length === 0) {
      return [];
    }
    const filter = buildPrFilterClause(parsed.filters, "p");
    const rows = this.db
      .prepare(
        `SELECT d.doc_id, d.pr_number, d.doc_kind, d.title, d.text, d.updated_at,
                vec_distance_cosine(v.embedding, ?) AS dist
           FROM ${VECTOR_TABLE} v
           JOIN search_docs d ON d.doc_id = v.id
           JOIN prs p ON p.number = d.pr_number
          ${filter.sql}
          ORDER BY dist ASC
          LIMIT ?`,
      )
      .all(toVectorBlob(queryVec), ...filter.params, limit) as Array<{
      doc_id: string;
      pr_number: number;
      doc_kind: "pr_body" | "comment";
      title: string;
      text: string;
      updated_at: string;
      dist: number;
    }>;

    return rows.map((row) => ({
      doc_id: row.doc_id,
      pr_number: row.pr_number,
      doc_kind: row.doc_kind,
      title: row.title,
      text: row.text,
      updated_at: row.updated_at,
      score: 1 - row.dist,
    }));
  }

  private getPrRow(prNumber: number): PrRow | null {
    return getPrRow(this.db, prNumber);
  }

  private getIssueRow(issueNumber: number): IssueRow | null {
    return getIssueRow(this.db, issueNumber);
  }

  private getLinkedIssuesForPr(prNumber: number): PullRequestLinkedIssue[] {
    return getLinkedIssuesForPr(this.db, prNumber);
  }

  private getChangedFilesForPr(prNumber: number): PullRequestChangedFile[] {
    return getChangedFilesForPr(this.db, prNumber);
  }

  private findPullRequestsByLinkedIssues(issueNumbers: number[]): number[] {
    if (issueNumbers.length === 0) {
      return [];
    }
    const placeholders = issueNumbers.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT pr_number
           FROM pr_linked_issues
          WHERE issue_number IN (${placeholders})
          ORDER BY pr_number DESC`,
      )
      .all(...issueNumbers) as Array<{ pr_number: number }>;
    return rows.map((row) => row.pr_number);
  }

  private async ensurePullRequestCached(
    repo: RepoRef,
    source: PullRequestDataSource,
    prNumber: number,
    refresh = false,
  ): Promise<void> {
    const hasPrRow = this.getPrRow(prNumber) !== null;
    if (!hasPrRow || refresh) {
      const hydrated = await source.hydratePullRequest(repo, prNumber);
      await this.upsertHydratedPullRequest(hydrated, { indexVectors: false });
    }
    if (!source.fetchPullRequestFacts) {
      return;
    }
    const facts = await this.getPullRequestFacts(prNumber);
    if (!facts || refresh) {
      await this.recordPullRequestFacts(await source.fetchPullRequestFacts(repo, prNumber));
    }
  }

  async refreshPullRequestDetail(
    repo: RepoRef,
    source: PullRequestDataSource,
    prNumber: number,
  ): Promise<void> {
    await this.init();
    await this.ensurePullRequestCached(repo, source, prNumber, true);
  }

  async refreshIssueDetail(
    repo: RepoRef,
    source: IssueDataSource,
    issueNumber: number,
  ): Promise<void> {
    await this.init();
    const issue = await source.getIssue(repo, issueNumber);
    this.upsertIssue(issue);
  }

  private buildClusterCandidate(
    prNumber: number,
    status: ClusterCandidate["status"],
    matchedBy: ClusterMatchSource,
    reason?: string,
    reasonCodes: ClusterReasonCode[] = [],
    semanticScore?: number,
    supersededBy?: number,
  ): ClusterCandidate | null {
    const pr = this.getPrRow(prNumber);
    if (!pr) {
      return null;
    }
    const facts = this.getChangedFilesForPr(prNumber);
    const linkedIssues = this.getLinkedIssuesForPr(prNumber).map((issue) => issue.issueNumber);
    return withClusterFeatures(
      {
        prNumber,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        updatedAt: pr.updated_at,
        matchedBy,
        headSha:
          (
            this.db
              .prepare(`SELECT head_sha FROM pr_fact_snapshots WHERE pr_number = ?`)
              .get(prNumber) as { head_sha: string } | undefined
          )?.head_sha ?? null,
        linkedIssues,
        prodFiles: facts.filter((file) => file.kind === "prod").map((file) => file.path),
        testFiles: facts.filter((file) => file.kind === "test").map((file) => file.path),
        otherFiles: facts.filter((file) => file.kind === "other").map((file) => file.path),
        relevantProdFiles: [],
        relevantTestFiles: [],
        noiseFilesCount: 0,
        status,
        reasonCodes,
        semanticScore,
        supersededBy,
        reason,
      },
      [],
    );
  }

  private async collectLiveIssueSearchCandidates(
    repo: RepoRef,
    source: PullRequestDataSource,
    issueNumbers: number[],
    limit: number,
  ): Promise<Map<number, ClusterMatchSource>> {
    const out = new Map<number, ClusterMatchSource>();
    if (!source.searchPullRequestNumbers) {
      return out;
    }
    for (const issueNumber of issueNumbers) {
      for (const state of ["open", "closed"] as const) {
        const numbers = await source.searchPullRequestNumbers(repo, String(issueNumber), {
          state,
          limit,
        });
        for (const prNumber of numbers) {
          out.set(prNumber, "live_issue_search");
        }
      }
    }
    return out;
  }

  private async collectLiveSemanticCandidates(
    repo: RepoRef,
    source: PullRequestDataSource,
    seed: PrRow,
    limit: number,
  ): Promise<Map<number, ClusterMatchSource>> {
    const out = new Map<number, ClusterMatchSource>();
    if (!source.searchPullRequestNumbers) {
      return out;
    }
    for (const query of buildLiveSemanticQueries(seed)) {
      for (const state of ["open", "closed"] as const) {
        const numbers = await source.searchPullRequestNumbers(repo, query, {
          state,
          limit,
        });
        for (const prNumber of numbers) {
          if (prNumber !== seed.number) {
            out.set(prNumber, "live_semantic");
          }
        }
      }
    }
    return out;
  }

  private resolveMergeReadiness(candidate: ClusterCandidate | null): MergeReadiness | null {
    if (!candidate) {
      return null;
    }
    const repo = this.getMeta(META_REPO) ?? "";
    const latestReviewFact = repo ? this.getLatestReviewFact(candidate.prNumber, repo) : null;
    const snapshot = this.db
      .prepare(
        `SELECT review_decision, merge_state_status, mergeable, status_rollup_json
           FROM pr_fact_snapshots
          WHERE pr_number = ?`,
      )
      .get(candidate.prNumber) as
      | {
          review_decision: string | null;
          merge_state_status: string | null;
          mergeable: string | null;
          status_rollup_json: string;
        }
      | undefined;
    return resolveMergeReadinessModel({
      candidate,
      latestReviewFact,
      githubSnapshot: snapshot
        ? {
            reviewDecision: snapshot.review_decision,
            mergeStateStatus: snapshot.merge_state_status,
            mergeable: snapshot.mergeable,
            statusChecks: JSON.parse(
              snapshot.status_rollup_json,
            ) as PullRequestFactRecord["statusChecks"],
          }
        : null,
    });
  }

  private getLabelsForPr(prNumber: number): string[] {
    return getLabelsForPr(this.db, prNumber);
  }

  private getLabelsForIssue(issueNumber: number): string[] {
    return getLabelsForIssue(this.db, issueNumber);
  }

  async show(prNumber: number): Promise<PullRequestShowResult> {
    await this.init();
    const pr = this.getPrRow(prNumber);
    if (!pr) {
      return { pr: null, comments: [] };
    }
    const comments = this.db
      .prepare(
        `SELECT kind, author, created_at, url, body
           FROM pr_comments
          WHERE pr_number = ?
          ORDER BY updated_at DESC
          LIMIT 10`,
      )
      .all(prNumber) as Array<{
      kind: string;
      author: string;
      created_at: string;
      url: string;
      body: string;
    }>;
    return {
      pr: {
        prNumber: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        author: pr.author,
        labels: this.getLabelsForPr(pr.number),
        updatedAt: pr.updated_at,
        score: 1,
        matchedDocKind: "pr_body",
        matchedExcerpt: truncateUtf16Safe(normalizeSearchText(pr.body || pr.title), 280),
      },
      comments: comments.map((comment) => ({
        kind: comment.kind,
        author: comment.author,
        createdAt: comment.created_at,
        url: comment.url,
        excerpt: truncateUtf16Safe(comment.body, 240),
      })),
    };
  }

  async showIssue(issueNumber: number): Promise<IssueSearchResult | null> {
    await this.init();
    const issue = this.getIssueRow(issueNumber);
    if (!issue) {
      return null;
    }
    return {
      issueNumber: issue.number,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      author: issue.author,
      labels: this.getLabelsForIssue(issue.number),
      updatedAt: issue.updated_at,
      score: 1,
      matchedExcerpt: truncateUtf16Safe(normalizeSearchText(issue.body || issue.title), 280),
    };
  }

  async crossReferenceIssueToPullRequests(
    issueNumber: number,
    limit = DEFAULT_SEARCH_LIMIT,
  ): Promise<{ issue: IssueSearchResult | null; pullRequests: SearchResult[] }> {
    const issue = await this.showIssue(issueNumber);
    if (!issue) {
      return { issue: null, pullRequests: [] };
    }
    const query = buildCrossReferenceQuery(issue.title, issue.matchedExcerpt);
    return {
      issue,
      pullRequests: await this.search(query, limit),
    };
  }

  async crossReferencePullRequestToIssues(
    prNumber: number,
    limit = DEFAULT_SEARCH_LIMIT,
  ): Promise<{ pullRequest: SearchResult | null; issues: IssueSearchResult[] }> {
    const payload = await this.show(prNumber);
    if (!payload.pr) {
      return { pullRequest: null, issues: [] };
    }
    const query = buildCrossReferenceQuery(payload.pr.title, payload.pr.matchedExcerpt);
    return {
      pullRequest: payload.pr,
      issues: await this.searchIssues(query, limit),
    };
  }

  async clusterPullRequest(params: {
    prNumber: number;
    limit?: number;
    ftsOnly?: boolean;
    repo?: RepoRef;
    source?: PullRequestDataSource;
    refresh?: boolean;
  }): Promise<ClusterPullRequestAnalysis | null> {
    await this.init();
    await this.ensureDerivedIssueLinksBackfilled();
    const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;
    const seed = this.getPrRow(params.prNumber);
    if (!seed) {
      return null;
    }

    if (params.repo && params.source) {
      await this.ensurePullRequestCached(
        params.repo,
        params.source,
        params.prNumber,
        params.refresh ?? false,
      );
    }
    const seedLinkedIssues = this.getLinkedIssuesForPr(params.prNumber).map(
      (issue) => issue.issueNumber,
    );
    const localNearbyResults = await this.findRelatedPullRequests(params.prNumber, limit * 4, {
      ftsOnly: params.ftsOnly,
    });
    const localNearbyNumbers = new Map<number, ClusterMatchSource>(
      localNearbyResults.map((result) => [result.prNumber, "local_semantic"]),
    );

    if (seedLinkedIssues.length === 0) {
      const decisionTrace = [
        buildClusterDecisionTrace({
          phase: "seed",
          prNumber: seed.number,
          matchedBy: null,
          outcome: "semantic_only",
          summary: "Seed PR has no exact linked issues; falling back to semantic-only clustering.",
        }),
      ];
      const semanticNumbers = new Map<number, ClusterMatchSource>(localNearbyNumbers);
      if (params.repo && params.source) {
        const liveSemanticNumbers = await this.collectLiveSemanticCandidates(
          params.repo,
          params.source,
          seed,
          limit * 2,
        );
        for (const [prNumber, matchedBy] of liveSemanticNumbers) {
          semanticNumbers.set(prNumber, semanticNumbers.get(prNumber) ?? matchedBy);
        }
      }

      const sameClusterCandidates: ClusterCandidate[] = [];
      const nearbyButExcluded: ClusterExcludedCandidate[] = [];
      for (const [prNumber, matchedBy] of semanticNumbers) {
        if (params.repo && params.source) {
          await this.ensurePullRequestCached(
            params.repo,
            params.source,
            prNumber,
            params.refresh ?? false,
          );
        }
        const candidateRow = this.getPrRow(prNumber);
        if (!candidateRow) {
          continue;
        }
        const semanticScore = computeSemanticScore({
          seed: {
            title: seed.title,
            body: seed.body,
            changedFiles: this.getChangedFilesForPr(seed.number),
          },
          candidate: {
            title: candidateRow.title,
            body: candidateRow.body,
            changedFiles: this.getChangedFilesForPr(candidateRow.number),
          },
        });
        const candidate = this.buildClusterCandidate(
          prNumber,
          "possible_same_cluster",
          matchedBy,
          undefined,
          ["semantic_only_candidate"],
          semanticScore,
        );
        if (!candidate) {
          continue;
        }
        if (candidate.linkedIssues.length > 0) {
          const excluded = buildExcludedCandidate(
            candidate,
            "different_linked_issue",
            `different_linked_issue: ${candidate.linkedIssues.map((issue) => `#${issue}`).join(", ")}`,
          );
          nearbyButExcluded.push(excluded);
          decisionTrace.push(buildExcludedTrace(excluded));
          continue;
        }
        if (semanticScore >= 0.35) {
          const included = withClusterFeatures(
            {
              ...candidate,
              reason: "semantic-only candidate",
            },
            [],
          );
          sameClusterCandidates.push(included);
          decisionTrace.push(
            buildClusterDecisionTrace({
              phase: "candidate",
              prNumber: included.prNumber,
              matchedBy: included.matchedBy,
              outcome: "included",
              summary: included.reason ?? "Semantic-only candidate retained.",
              featureVector: included.featureVector,
              reasonCodes: included.reasonCodes,
            }),
          );
        } else {
          const excluded = buildExcludedCandidate(
            candidate,
            "semantic_weak_match",
            "semantic_weak_match: semantic overlap too weak",
          );
          nearbyButExcluded.push(excluded);
          decisionTrace.push(buildExcludedTrace(excluded));
        }
      }
      const orderedCandidates = sameClusterCandidates
        .sort((left, right) => {
          if ((right.semanticScore ?? 0) !== (left.semanticScore ?? 0)) {
            return (right.semanticScore ?? 0) - (left.semanticScore ?? 0);
          }
          return right.updatedAt.localeCompare(left.updatedAt);
        })
        .slice(0, limit);
      decisionTrace.push(
        buildClusterDecisionTrace({
          phase: "result",
          prNumber: null,
          matchedBy: null,
          outcome: "semantic_only_result",
          summary: semanticOnlyResultSummary(orderedCandidates.length),
        }),
      );
      return {
        seedPr: buildClusterSeed(seed),
        clusterBasis: "semantic_only",
        clusterIssueNumbers: [],
        bestBase: null,
        sameClusterCandidates: orderedCandidates,
        nearbyButExcluded: nearbyButExcluded.slice(0, limit),
        mergeReadiness: null,
        decisionTrace,
      };
    }

    const exactMatches = new Map<number, ClusterMatchSource>([[params.prNumber, "linked_issue"]]);
    for (const prNumber of this.findPullRequestsByLinkedIssues(seedLinkedIssues)) {
      exactMatches.set(prNumber, "linked_issue");
    }
    if (params.repo && params.source) {
      const liveIssueMatches = await this.collectLiveIssueSearchCandidates(
        params.repo,
        params.source,
        seedLinkedIssues,
        limit * 3,
      );
      for (const [prNumber, matchedBy] of liveIssueMatches) {
        await this.ensurePullRequestCached(
          params.repo,
          params.source,
          prNumber,
          params.refresh ?? false,
        );
        const linkedIssues = this.getLinkedIssuesForPr(prNumber).map((issue) => issue.issueNumber);
        if (linkedIssues.some((issue) => seedLinkedIssues.includes(issue))) {
          exactMatches.set(prNumber, exactMatches.get(prNumber) ?? matchedBy);
        }
      }
    }

    const rawCandidates = Array.from(exactMatches.entries())
      .map(([prNumber, matchedBy]) =>
        this.buildClusterCandidate(
          prNumber,
          "same_cluster_candidate",
          matchedBy,
          matchedBy === "live_issue_search" ? "discovered via live issue search" : undefined,
          matchedBy === "live_issue_search"
            ? ["same_linked_issue", "discovered_via_live_issue_search"]
            : ["same_linked_issue"],
        ),
      )
      .filter((candidate): candidate is ClusterCandidate => Boolean(candidate));
    const decisionTrace = [
      buildClusterDecisionTrace({
        phase: "seed",
        prNumber: seed.number,
        matchedBy: null,
        outcome: "linked_issue_seed",
        summary: `Seed PR links issues ${seedLinkedIssues.map((issue) => `#${issue}`).join(", ")}.`,
      }),
      ...rawCandidates.map((candidate) =>
        buildClusterDecisionTrace({
          phase: "candidate",
          prNumber: candidate.prNumber,
          matchedBy: candidate.matchedBy,
          outcome: "candidate_generated",
          summary:
            candidate.reason ??
            (candidate.matchedBy === "live_issue_search"
              ? "Candidate discovered via live issue search."
              : "Candidate shares the linked issue."),
          featureVector: candidate.featureVector,
          reasonCodes: candidate.reasonCodes,
        }),
      ),
    ];
    const relevantPaths = buildRelevantPathSets(params.prNumber, rawCandidates);
    const rankedCandidates = rawCandidates
      .map((candidate) =>
        annotateRelevantCoverage(
          candidate,
          relevantPaths.relevantProdFiles,
          relevantPaths.relevantTestFiles,
          seedLinkedIssues,
        ),
      )
      .sort((left, right) => rankClusterCandidates(seedLinkedIssues, left, right));

    const bestBase = rankedCandidates[0] ?? null;
    const runnerUp = rankedCandidates[1] ?? null;
    const sameClusterCandidates = rankedCandidates.slice(0, limit).map((candidate, index) => {
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

    const nearbyNumbers = new Map<number, ClusterMatchSource>(localNearbyNumbers);
    if (params.repo && params.source && nearbyNumbers.size < limit) {
      const liveSemanticNumbers = await this.collectLiveSemanticCandidates(
        params.repo,
        params.source,
        seed,
        limit * 2,
      );
      for (const [prNumber, matchedBy] of liveSemanticNumbers) {
        nearbyNumbers.set(prNumber, nearbyNumbers.get(prNumber) ?? matchedBy);
      }
    }

    const sameClusterSet = new Set(rankedCandidates.map((candidate) => candidate.prNumber));
    const nearbyButExcluded: ClusterExcludedCandidate[] = [];
    for (const [prNumber, matchedBy] of nearbyNumbers) {
      if (sameClusterSet.has(prNumber)) {
        continue;
      }
      if (params.repo && params.source) {
        await this.ensurePullRequestCached(
          params.repo,
          params.source,
          prNumber,
          params.refresh ?? false,
        );
      }
      const candidate = this.buildClusterCandidate(prNumber, "same_cluster_candidate", matchedBy);
      if (!candidate) {
        continue;
      }
      const annotated = annotateRelevantCoverage(
        candidate,
        relevantPaths.relevantProdFiles,
        relevantPaths.relevantTestFiles,
        seedLinkedIssues,
      );
      const otherLinkedIssues = annotated.linkedIssues.filter(
        (issue) => !seedLinkedIssues.includes(issue),
      );
      if (otherLinkedIssues.length > 0) {
        const excluded = buildExcludedCandidate(
          annotated,
          "different_linked_issue",
          `different_linked_issue: ${otherLinkedIssues.map((issue) => `#${issue}`).join(", ")}`,
        );
        nearbyButExcluded.push(excluded);
        decisionTrace.push(buildExcludedTrace(excluded));
        continue;
      }
      if (
        annotated.noiseFilesCount >
          annotated.relevantProdFiles.length + annotated.relevantTestFiles.length + 2 &&
        annotated.relevantProdFiles.length + annotated.relevantTestFiles.length <= 1
      ) {
        const excluded = buildExcludedCandidate(
          annotated,
          "noise_dominated",
          "noise_dominated: unrelated churn outweighs issue-relevant paths",
        );
        nearbyButExcluded.push(excluded);
        decisionTrace.push(buildExcludedTrace(excluded));
        continue;
      }
      const excluded = buildExcludedCandidate(
        annotated,
        "semantic_weak_match",
        "semantic_weak_match: semantic neighbor without exact issue link",
      );
      nearbyButExcluded.push(excluded);
      decisionTrace.push(buildExcludedTrace(excluded));
    }

    const resolvedBestBase =
      sameClusterCandidates.find((candidate) => candidate.status === "best_base") ?? bestBase;
    decisionTrace.push(
      buildClusterDecisionTrace({
        phase: "result",
        prNumber: resolvedBestBase?.prNumber ?? null,
        matchedBy: resolvedBestBase?.matchedBy ?? null,
        outcome: resolvedBestBase ? "linked_issue_result" : "linked_issue_result_empty",
        summary: linkedIssueResultSummary(seedLinkedIssues, resolvedBestBase),
        featureVector: resolvedBestBase?.featureVector,
        reasonCodes: resolvedBestBase?.reasonCodes,
      }),
    );

    return {
      seedPr: buildClusterSeed(seed),
      clusterBasis: "linked_issue",
      clusterIssueNumbers: seedLinkedIssues,
      bestBase: resolvedBestBase,
      sameClusterCandidates,
      nearbyButExcluded: nearbyButExcluded.slice(0, limit),
      mergeReadiness: this.resolveMergeReadiness(resolvedBestBase),
      decisionTrace,
    };
  }

  async listSemanticCorpusDocuments(): Promise<SemanticCorpusDocument[]> {
    await this.init();
    const rows = this.db
      .prepare(
        `SELECT d.doc_id, d.pr_number, d.doc_kind, d.title, d.text, d.updated_at,
                p.state, p.author, p.head_ref,
                COALESCE(GROUP_CONCAT(l.label_name, char(31)), '') AS labels
           FROM search_docs d
           JOIN prs p ON p.number = d.pr_number
      LEFT JOIN pr_labels l ON l.pr_number = d.pr_number
       GROUP BY d.doc_id, d.pr_number, d.doc_kind, d.title, d.text, d.updated_at,
                p.state, p.author, p.head_ref
       ORDER BY d.updated_at DESC, d.pr_number DESC`,
      )
      .all() as Array<{
      doc_id: string;
      pr_number: number;
      doc_kind: "pr_body" | "comment";
      title: string;
      text: string;
      updated_at: string;
      state: "open" | "closed" | "merged";
      author: string;
      head_ref: string;
      labels: string;
    }>;
    return rows.map((row) => ({
      docId: row.doc_id,
      prNumber: row.pr_number,
      docKind: row.doc_kind,
      title: row.title,
      text: row.text,
      updatedAt: row.updated_at,
      state: row.state,
      author: row.author,
      headRef: row.head_ref,
      labels: row.labels ? row.labels.split(String.fromCharCode(31)).filter(Boolean) : [],
    }));
  }

  async status(): Promise<StatusSnapshot> {
    await this.init();
    return {
      repo: this.getMeta(META_REPO) ?? "",
      lastSyncAt: this.getMeta(META_LAST_SYNC_AT),
      lastSyncWatermark: this.getMeta(META_LAST_SYNC_WATERMARK),
      issueLastSyncAt: this.getMeta(META_ISSUE_LAST_SYNC_AT),
      issueLastSyncWatermark: this.getMeta(META_ISSUE_LAST_SYNC_WATERMARK),
      prCount: this.countRows("prs"),
      issueCount: this.countRows("issues"),
      labelCount: this.countRows("pr_labels"),
      issueLabelCount: this.countRows("issue_labels"),
      commentCount: this.countRows("pr_comments"),
      docCount: this.countRows("search_docs"),
      vectorEnabled: this.enableVector,
      vectorAvailable: this.vectorAvailable,
      vectorError: this.vectorError,
      embeddingModel: this.embeddingModel,
    };
  }
}
