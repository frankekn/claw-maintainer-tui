import * as path from "node:path";
import { runTasksWithConcurrency } from "./lib/concurrency.js";
import { buildFtsQuery, bm25RankToScore } from "./lib/hybrid.js";
import { ensureDir, hashText } from "./lib/internal.js";
import { collectLinkedIssuesFromPrText } from "./lib/pull-request-facts.js";
import {
  FACT_OWNED_PULL_REQUEST_LINK_SOURCES,
  TEXT_DERIVED_PULL_REQUEST_LINK_SOURCES,
  isFactOwnedPullRequestLinkSource,
} from "./lib/pull-request-links.js";
import { loadSqliteVecExtension } from "./lib/sqlite-vec.js";
import { requireNodeSqlite } from "./lib/sqlite.js";
import { truncateUtf16Safe } from "./lib/text.js";
import { isoNow } from "./lib/time.js";
import {
  annotateRelevantCoverage,
  buildClusterSemanticText,
  buildLiveSemanticQueries,
  buildRelevantPathSets,
  computeSemanticScore,
  rankClusterCandidates,
} from "./store/cluster-logic.js";
import {
  buildClusterDecisionTrace,
  buildExcludedTrace,
  withClusterFeatures,
} from "./store/cluster-analysis.js";
import { buildPrContextBundle } from "./store/context-bundle.js";
import {
  buildLinkedIssueClusterResult,
  buildSemanticOnlyClusterResult,
  classifyNearbyExcludedCandidate,
  evaluateSemanticOnlyCandidate,
  orderSemanticOnlyCandidates,
  rankClusterDecisionSet,
} from "./store/cluster-workflow.js";
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
import { mergeSummaryPullRequestRecord } from "./store/pull-request-sync-contract.js";
import { syncIssuesWorkflow, syncPullRequestsWorkflow } from "./store/sync-workflow.js";
import {
  buildCrossReferenceQuery,
  extractChangedFileTerms,
  normalizeSearchText,
  uniqueStrings,
} from "./store/text.js";
import { pullRequestUpsertParams, UPSERT_PULL_REQUEST_SQL } from "./store/upsert.js";
import {
  createLocalEmbeddingProvider,
  DEFAULT_GH_INTEL_LOCAL_MODEL,
  type LocalEmbeddingProvider,
} from "./embedding.js";
import type {
  AttentionState,
  ClusterCandidate,
  ClusterDecisionTrace,
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
  PriorityClusterSummary,
  PriorityInboxItem,
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
const META_CHANGED_FILE_TERMS_BACKFILLED_AT = "changed_file_terms_backfilled_at";
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const CLUSTER_EMBEDDING_PROVIDER = "cluster";
const CLUSTER_LOCAL_PATH_LIMIT = 16;
const CLUSTER_EMBEDDING_RERANK_LIMIT = 12;
const EXACT_CLUSTER_PATH_CAP = 40;

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

type ClusterInputBundle = {
  pr: PrRow;
  headSha: string | null;
  linkedIssues: number[];
  changedFiles: PullRequestChangedFile[];
};

type CachedLinkedIssueClusterEvaluation = {
  clusterIssueNumbers: number[];
  decisionTrace: ClusterDecisionTrace[];
  rankedCandidates: ClusterCandidate[];
  relevantPaths: {
    relevantProdFiles: Set<string>;
    relevantTestFiles: Set<string>;
  };
  bestBase: ClusterCandidate | null;
  sameClusterCandidates: ClusterCandidate[];
};

function toVectorBlob(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

function buildSearchDocuments(payload: HydratedPullRequest): SearchDocument[] {
  const docs: SearchDocument[] = [];
  const prTitle = payload.pr.title.trim();
  const prDoc = buildPullRequestBodyDocument(payload.pr);
  if (prDoc) {
    docs.push(prDoc);
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

function buildPullRequestBodyDocument(pr: PullRequestRecord): SearchDocument | null {
  const text = normalizeSearchText([pr.title, pr.body].filter(Boolean).join("\n\n"));
  if (!text) {
    return null;
  }
  return {
    docId: `pr:${pr.number}`,
    prNumber: pr.number,
    kind: "pr_body",
    title: pr.title.trim(),
    text,
    updatedAt: pr.updatedAt,
    hash: hashText(text),
  };
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
  private readonly linkedIssueClusterCache = new Map<string, CachedLinkedIssueClusterEvaluation>();

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

      CREATE TABLE IF NOT EXISTS pr_changed_file_terms (
        pr_number INTEGER NOT NULL,
        term_kind TEXT NOT NULL,
        term_value TEXT NOT NULL,
        PRIMARY KEY (pr_number, term_kind, term_value)
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
      `CREATE INDEX IF NOT EXISTS idx_pr_changed_file_terms_lookup
         ON pr_changed_file_terms(term_kind, term_value, pr_number);`,
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

  private clearLinkedIssueClusterCache(): void {
    this.linkedIssueClusterCache.clear();
  }

  private rebuildChangedFileTermsForPr(
    prNumber: number,
    changedFiles: Array<Pick<PullRequestChangedFile, "path" | "kind">>,
  ): void {
    this.db.prepare("DELETE FROM pr_changed_file_terms WHERE pr_number = ?").run(prNumber);
    const rows = changedFiles
      .filter((file) => file.kind !== "other")
      .flatMap((file) => extractChangedFileTerms(file.path));
    for (const row of rows) {
      this.db
        .prepare(
          `INSERT INTO pr_changed_file_terms (pr_number, term_kind, term_value)
           VALUES (?, ?, ?)
           ON CONFLICT(pr_number, term_kind, term_value) DO NOTHING`,
        )
        .run(prNumber, row.kind, row.value);
    }
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
    this.clearIssueLinksForSources(prNumber, TEXT_DERIVED_PULL_REQUEST_LINK_SOURCES);
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
          `DELETE FROM pr_linked_issues WHERE link_source IN (${TEXT_DERIVED_PULL_REQUEST_LINK_SOURCES.map(() => "?").join(", ")})`,
        )
        .run(...TEXT_DERIVED_PULL_REQUEST_LINK_SOURCES);
      for (const row of rows) {
        this.upsertDerivedIssueLinksForPr(row.number, row.title, row.body);
      }
      this.setMeta(META_DERIVED_ISSUE_LINKS_BACKFILLED_AT, isoNow());
      this.clearLinkedIssueClusterCache();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async ensureChangedFileTermsBackfilled(): Promise<void> {
    await this.init();
    if (this.getMeta(META_CHANGED_FILE_TERMS_BACKFILLED_AT)) {
      return;
    }
    const rows = this.db
      .prepare("SELECT pr_number, path, kind FROM pr_changed_files")
      .all() as Array<{
      pr_number: number;
      path: string;
      kind: PullRequestChangedFile["kind"];
    }>;
    const byPr = new Map<number, PullRequestChangedFile[]>();
    for (const row of rows) {
      const files = byPr.get(row.pr_number) ?? [];
      files.push({ path: row.path, kind: row.kind });
      byPr.set(row.pr_number, files);
    }
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM pr_changed_file_terms");
      for (const [prNumber, files] of byPr) {
        this.rebuildChangedFileTermsForPr(prNumber, files);
      }
      this.setMeta(META_CHANGED_FILE_TERMS_BACKFILLED_AT, isoNow());
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
      this.clearIssueLinksForSources(facts.prNumber, FACT_OWNED_PULL_REQUEST_LINK_SOURCES);
      for (const issue of facts.linkedIssues.filter((linkedIssue) =>
        isFactOwnedPullRequestLinkSource(linkedIssue.linkSource),
      )) {
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
      this.rebuildChangedFileTermsForPr(facts.prNumber, facts.changedFiles);
      this.clearLinkedIssueClusterCache();
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

  private isVisibleOnPrioritySurfaces(repo: string, prNumber: number): boolean {
    return this.getAttentionState(repo, prNumber) !== "ignore";
  }

  private filterVisibleSearchResults(
    repo: string,
    results: Iterable<SearchResult>,
  ): SearchResult[] {
    return Array.from(results).filter((result) =>
      this.isVisibleOnPrioritySurfaces(repo, result.prNumber),
    );
  }

  private filterVisibleClusterAnalysis(
    repo: string,
    analysis: ClusterPullRequestAnalysis | null,
  ): ClusterPullRequestAnalysis | null {
    if (!analysis) {
      return null;
    }
    return {
      ...analysis,
      sameClusterCandidates: analysis.sameClusterCandidates.filter((candidate) =>
        this.isVisibleOnPrioritySurfaces(repo, candidate.prNumber),
      ),
      nearbyButExcluded: analysis.nearbyButExcluded.filter((candidate) =>
        this.isVisibleOnPrioritySurfaces(repo, candidate.prNumber),
      ),
    };
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

  private comparePriorityCandidates(left: PriorityCandidate, right: PriorityCandidate): number {
    return (
      right.score - left.score ||
      right.pr.updatedAt.localeCompare(left.pr.updatedAt) ||
      right.pr.prNumber - left.pr.prNumber
    );
  }

  private async enrichPriorityCandidate(
    candidate: PriorityCandidate,
    options: { relatedLimit?: number; clusterLimit?: number; repoKey?: string } = {},
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
      repoKey: options.repoKey,
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

  private async collectPrioritizedOpenCandidates(params: {
    repoKey: string;
    limit: number;
    scanLimit?: number;
  }): Promise<PriorityCandidate[]> {
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
      .all(params.repoKey) as PrRow[];

    const byNumber = new Map<number, PrRow>();
    for (const row of recentOpen) {
      byNumber.set(row.number, row);
    }
    for (const row of watchedOpen) {
      byNumber.set(row.number, row);
    }

    const baseline = Array.from(byNumber.values())
      .map((row) => this.buildPriorityCandidateBase(row, params.repoKey))
      .filter((candidate) => candidate.attentionState !== "ignore")
      .sort((left, right) => this.comparePriorityCandidates(left, right));

    const topForEnrichment = baseline.slice(0, Math.min(80, baseline.length));
    const enriched = new Map<number, PriorityCandidate>();
    const result = await runTasksWithConcurrency({
      tasks: topForEnrichment.map((candidate) => async () => {
        enriched.set(
          candidate.pr.prNumber,
          await this.enrichPriorityCandidate(candidate, { repoKey: params.repoKey }),
        );
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
      .sort((left, right) => this.comparePriorityCandidates(left, right));
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

  private collectCachedEmbeddings(providerKey: string, hashes: string[]): Map<string, number[]> {
    if (hashes.length === 0) {
      return new Map();
    }
    const placeholders = hashes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE} WHERE provider = ? AND model = ? AND hash IN (${placeholders})`,
      )
      .all(providerKey, this.embeddingModel, ...hashes) as Array<{
      hash: string;
      embedding: string;
    }>;
    const out = new Map<string, number[]>();
    for (const row of rows) {
      out.set(row.hash, JSON.parse(row.embedding) as number[]);
    }
    return out;
  }

  private async embedTextEntries(
    providerKey: string,
    entries: Array<{ hash: string; text: string }>,
  ): Promise<Map<string, number[]>> {
    const byHash = this.collectCachedEmbeddings(
      providerKey,
      entries.map((entry) => entry.hash),
    );
    if (!this.vectorAvailable) {
      return byHash;
    }
    const provider = await this.ensureEmbeddingProvider();
    if (!provider) {
      return byHash;
    }
    const missing = entries.filter((entry) => !byHash.has(entry.hash));
    if (missing.length === 0) {
      return byHash;
    }
    try {
      const vectors = await provider.embedBatch(missing.map((entry) => entry.text));
      const timestamp = isoNow();
      for (let index = 0; index < missing.length; index += 1) {
        const entry = missing[index]!;
        const embedding = vectors[index] ?? [];
        if (embedding.length === 0) {
          continue;
        }
        byHash.set(entry.hash, embedding);
        this.db
          .prepare(
            `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, hash, embedding, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(provider, model, hash) DO UPDATE SET embedding = excluded.embedding, updated_at = excluded.updated_at`,
          )
          .run(providerKey, this.embeddingModel, entry.hash, JSON.stringify(embedding), timestamp);
      }
    } catch (error) {
      this.vectorError = error instanceof Error ? error.message : String(error);
      this.vectorAvailable = false;
    }
    return byHash;
  }

  private async embedDocuments(docs: SearchDocument[]): Promise<Map<string, number[]>> {
    return this.embedTextEntries(
      "local",
      docs.map((doc) => ({ hash: doc.hash, text: doc.text })),
    );
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

  private upsertPullRequestSummary(
    pr: PullRequestRecord,
    authority: "authoritative" | "partial",
  ): void {
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
    const mergedRecord = mergeSummaryPullRequestRecord({
      pr,
      authority,
      existing: existing
        ? {
            state: existing.state,
            isDraft: Boolean(existing.is_draft),
            baseRef: existing.base_ref,
            headRef: existing.head_ref,
            url: existing.url,
            closedAt: existing.closed_at,
            mergedAt: existing.merged_at,
          }
        : null,
    });
    const prDoc = buildPullRequestBodyDocument(mergedRecord);

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

      this.clearLinkedIssueClusterCache();
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

        this.clearLinkedIssueClusterCache();
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
    const workflow = await syncPullRequestsWorkflow({
      ...params,
      syncConcurrency: this.syncConcurrency,
      lastSyncWatermark: this.getMeta(META_LAST_SYNC_WATERMARK),
      repoName,
      vectorAvailable: this.vectorAvailable,
      getStoredUpdatedAt: (prNumber) => this.getStoredUpdatedAt(prNumber),
      upsertHydratedPullRequest: (payload, options) =>
        this.upsertHydratedPullRequest(payload, options),
      upsertPullRequestSummary: (pr, authority) => this.upsertPullRequestSummary(pr, authority),
      setMeta: (key, value) => this.setMeta(key, value),
      countRows: (table) => this.countRows(table),
      metaKeys: {
        repo: META_REPO,
        lastSyncAt: META_LAST_SYNC_AT,
        lastSyncWatermark: META_LAST_SYNC_WATERMARK,
      },
    });
    await this.prewarmPullRequestFacts({
      repo: params.repo,
      source: params.source,
      touchedPrNumbers: workflow.touchedPrNumbers,
    });
    return workflow.summary;
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

  private getOpenPrRows(prNumbers: number[]): PrRow[] {
    return Array.from(new Set(prNumbers))
      .map((prNumber) => this.getPrRow(prNumber))
      .filter((row): row is PrRow => row !== null && row.state === "open")
      .sort(
        (left, right) =>
          right.updated_at.localeCompare(left.updated_at) || right.number - left.number,
      );
  }

  private getWatchedOpenPrRows(repoKey: string): PrRow[] {
    return this.db
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
  }

  private buildPrewarmQueue(repoKey: string, touchedPrNumbers: number[]): number[] {
    const touchedOpenRows = this.getOpenPrRows(touchedPrNumbers);
    const familyRepresentatives = new Map<string, PrRow>();
    const selected = new Set<number>();
    const queue: number[] = [];

    for (const row of touchedOpenRows) {
      const issueNumbers = this.getLinkedIssuesForPr(row.number).map((issue) => issue.issueNumber);
      if (issueNumbers.length === 0) {
        continue;
      }
      const familyKey = issueNumbers.sort((left, right) => left - right).join(",");
      const current = familyRepresentatives.get(familyKey);
      if (
        !current ||
        row.updated_at > current.updated_at ||
        (row.updated_at === current.updated_at && row.number > current.number)
      ) {
        familyRepresentatives.set(familyKey, row);
      }
    }

    for (const row of Array.from(familyRepresentatives.values()).sort(
      (left, right) =>
        right.updated_at.localeCompare(left.updated_at) || right.number - left.number,
    )) {
      selected.add(row.number);
      queue.push(row.number);
    }

    for (const row of this.getWatchedOpenPrRows(repoKey)) {
      if (selected.has(row.number)) {
        continue;
      }
      selected.add(row.number);
      queue.push(row.number);
    }

    for (const row of touchedOpenRows) {
      if (selected.has(row.number)) {
        continue;
      }
      const issueNumbers = this.getLinkedIssuesForPr(row.number).map((issue) => issue.issueNumber);
      if (issueNumbers.length > 0) {
        continue;
      }
      selected.add(row.number);
      queue.push(row.number);
    }

    return queue;
  }

  private async prewarmPullRequestFacts(params: {
    repo: RepoRef;
    source: PullRequestDataSource;
    touchedPrNumbers: number[];
  }): Promise<void> {
    if (!params.source.fetchPullRequestFacts || params.touchedPrNumbers.length === 0) {
      return;
    }

    const repoKey = this.repoKey(params.repo);
    const queue = this.buildPrewarmQueue(repoKey, params.touchedPrNumbers);
    if (queue.length === 0) {
      return;
    }

    const rateLimit = await params.source.getRateLimitStatus?.();
    if (rateLimit && rateLimit.remaining < 100) {
      return;
    }
    const concurrency =
      rateLimit && rateLimit.remaining < 250
        ? 1
        : Math.max(1, Math.floor(this.syncConcurrency / 2));

    await runTasksWithConcurrency({
      tasks: queue.map((prNumber) => async () => {
        await this.ensurePullRequestFactsCached(params.repo, params.source, prNumber);
        return prNumber;
      }),
      limit: concurrency,
      errorMode: "continue",
    });
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
    return (
      await this.collectPrioritizedOpenCandidates({
        repoKey,
        limit: params.limit,
        scanLimit: params.scanLimit,
      })
    ).slice(0, params.limit);
  }

  private async getOrBuildPriorityCandidate(
    prNumber: number,
    repoKey: string,
    cache: Map<number, PriorityCandidate>,
  ): Promise<PriorityCandidate | null> {
    const cached = cache.get(prNumber);
    if (cached) {
      return cached;
    }
    const pr = this.getPrRow(prNumber);
    if (!pr || pr.state !== "open") {
      return null;
    }
    const candidate = await this.enrichPriorityCandidate(
      this.buildPriorityCandidateBase(pr, repoKey),
      { repoKey },
    );
    if (!this.isVisibleOnPrioritySurfaces(repoKey, candidate.pr.prNumber)) {
      return null;
    }
    cache.set(prNumber, candidate);
    return candidate;
  }

  private buildPriorityClusterSummary(params: {
    clusterKey: string;
    basis: PriorityClusterSummary["basis"];
    issueNumbers: number[];
    openMembers: PriorityCandidate[];
    allStateRows: Array<Pick<ClusterCandidate, "prNumber" | "state" | "updatedAt">>;
    representativeHints: Set<number>;
  }): PriorityClusterSummary {
    const openMembers = [...params.openMembers].sort((left, right) =>
      this.comparePriorityCandidates(left, right),
    );
    const hintedRepresentative =
      openMembers.find((candidate) => params.representativeHints.has(candidate.pr.prNumber)) ??
      null;
    const representative = hintedRepresentative ?? openMembers[0]!;
    const mergedRows = params.allStateRows
      .filter((row) => row.state === "merged")
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || right.prNumber - left.prNumber,
      );
    const openPrCount = params.allStateRows.filter((row) => row.state === "open").length;
    const mergedPrCount = mergedRows.length;
    const totalPrCount = params.allStateRows.length;
    const solvedByPrNumber = mergedRows[0]?.prNumber ?? null;

    let recommendation: PriorityClusterSummary["recommendation"];
    let statusLabel: string;
    let statusReason: string;
    let score = representative.score;

    if (solvedByPrNumber !== null) {
      recommendation = "merged_exists";
      statusLabel = "merged exists";
      statusReason = `Merged PR #${solvedByPrNumber} already covers this cluster.`;
      score -= 18;
    } else if (openPrCount > 1) {
      recommendation = "open_variants";
      statusLabel = `${openPrCount} open variants`;
      statusReason = `${openPrCount} open PRs are competing in the same cluster.`;
      score += Math.min(12, 4 + Math.max(0, openPrCount - 2) * 2);
    } else {
      recommendation = "semantic_family";
      statusLabel = "semantic family";
      statusReason = "Strong semantic overlap groups these PRs together.";
      score -= 6;
    }

    return {
      clusterKey: params.clusterKey,
      basis: params.basis,
      representative,
      openMembers,
      score,
      totalPrCount,
      openPrCount,
      mergedPrCount,
      linkedIssueCount: params.issueNumbers.length,
      clusterIssueNumbers: [...params.issueNumbers].sort((left, right) => left - right),
      statusLabel,
      statusReason,
      recommendation,
      solvedByPrNumber,
    };
  }

  async listPriorityInbox(params: {
    repo: RepoRef | string;
    limit: number;
    scanLimit?: number;
  }): Promise<PriorityInboxItem[]> {
    await this.init();
    await this.ensureDerivedIssueLinksBackfilled();
    const repoKey = this.repoKey(params.repo);
    const prioritized = await this.collectPrioritizedOpenCandidates({
      repoKey,
      limit: params.limit,
      scanLimit: params.scanLimit,
    });
    const seedWindow = prioritized.slice(
      0,
      Math.min(prioritized.length, Math.max(params.limit * 4, 60)),
    );
    const candidateCache = new Map<number, PriorityCandidate>(
      prioritized.map((candidate) => [candidate.pr.prNumber, candidate]),
    );
    const analysisByNumber = new Map<number, ClusterPullRequestAnalysis | null>();
    const analysisResult = await runTasksWithConcurrency({
      tasks: seedWindow.map((candidate) => async () => {
        analysisByNumber.set(
          candidate.pr.prNumber,
          await this.clusterPullRequest({
            prNumber: candidate.pr.prNumber,
            limit: 12,
            ftsOnly: true,
            repoKey,
          }),
        );
        return candidate.pr.prNumber;
      }),
      limit: 6,
      errorMode: "stop",
    });
    if (analysisResult.hasError) {
      throw analysisResult.firstError;
    }

    const exactGroups = new Map<string, { issueNumbers: number[]; openNumbers: Set<number> }>();
    const semanticAdjacent = new Map<number, Set<number>>();
    const semanticMergedBySeed = new Map<
      number,
      Array<Pick<ClusterCandidate, "prNumber" | "state" | "updatedAt">>
    >();

    for (const candidate of seedWindow) {
      const analysis = analysisByNumber.get(candidate.pr.prNumber);
      if (!analysis) {
        continue;
      }
      if (analysis.clusterBasis === "linked_issue" && analysis.clusterIssueNumbers.length > 0) {
        const clusterKey = `issue:${[...analysis.clusterIssueNumbers].sort((left, right) => left - right).join(",")}`;
        const group = exactGroups.get(clusterKey) ?? {
          issueNumbers: [...analysis.clusterIssueNumbers],
          openNumbers: new Set<number>(),
        };
        group.openNumbers.add(candidate.pr.prNumber);
        for (const clusterCandidate of analysis.sameClusterCandidates) {
          if (clusterCandidate.state === "open") {
            group.openNumbers.add(clusterCandidate.prNumber);
          }
        }
        exactGroups.set(clusterKey, group);
        continue;
      }

      if (analysis.clusterBasis === "semantic_only") {
        const mergedRows = analysis.sameClusterCandidates
          .filter((clusterCandidate) => clusterCandidate.state === "merged")
          .map((clusterCandidate) => ({
            prNumber: clusterCandidate.prNumber,
            state: clusterCandidate.state,
            updatedAt: clusterCandidate.updatedAt,
          }));
        if (mergedRows.length > 0) {
          semanticMergedBySeed.set(candidate.pr.prNumber, mergedRows);
        }
        for (const clusterCandidate of analysis.sameClusterCandidates) {
          if (clusterCandidate.state !== "open") {
            continue;
          }
          const existing = semanticAdjacent.get(candidate.pr.prNumber) ?? new Set<number>();
          existing.add(clusterCandidate.prNumber);
          semanticAdjacent.set(candidate.pr.prNumber, existing);
          const reverse = semanticAdjacent.get(clusterCandidate.prNumber) ?? new Set<number>();
          reverse.add(candidate.pr.prNumber);
          semanticAdjacent.set(clusterCandidate.prNumber, reverse);
        }
      }
    }

    const consumedOpenNumbers = new Set<number>();
    const clusterSummaries: PriorityClusterSummary[] = [];

    for (const [clusterKey, group] of exactGroups) {
      const allNumbers = new Set(this.findPullRequestsByLinkedIssues(group.issueNumbers));
      const allRows = Array.from(allNumbers)
        .map((prNumber) => this.getPrRow(prNumber))
        .filter((row): row is PrRow => Boolean(row));
      if (allRows.length <= 1) {
        continue;
      }
      const openMembers = (
        await Promise.all(
          allRows
            .filter((row) => row.state === "open")
            .map((row) => this.getOrBuildPriorityCandidate(row.number, repoKey, candidateCache)),
        )
      ).filter((candidate): candidate is PriorityCandidate => Boolean(candidate));
      const unconsumedOpenMembers = openMembers.filter(
        (member) => !consumedOpenNumbers.has(member.pr.prNumber),
      );
      if (unconsumedOpenMembers.length === 0) {
        continue;
      }
      const representativeHints = new Set<number>();
      for (const member of unconsumedOpenMembers) {
        const analysis = analysisByNumber.get(member.pr.prNumber);
        if (analysis?.bestBase?.state === "open") {
          representativeHints.add(analysis.bestBase.prNumber);
        }
      }
      clusterSummaries.push(
        this.buildPriorityClusterSummary({
          clusterKey,
          basis: "linked_issue",
          issueNumbers: group.issueNumbers,
          openMembers: unconsumedOpenMembers,
          allStateRows: allRows.map((row) => ({
            prNumber: row.number,
            state: row.state,
            updatedAt: row.updated_at,
          })),
          representativeHints,
        }),
      );
      for (const member of unconsumedOpenMembers) {
        consumedOpenNumbers.add(member.pr.prNumber);
      }
    }

    const semanticVisited = new Set<number>();
    for (const candidate of seedWindow) {
      if (
        consumedOpenNumbers.has(candidate.pr.prNumber) ||
        semanticVisited.has(candidate.pr.prNumber)
      ) {
        continue;
      }
      const queue = [candidate.pr.prNumber];
      const component = new Set<number>();
      while (queue.length > 0) {
        const current = queue.pop()!;
        if (semanticVisited.has(current) || consumedOpenNumbers.has(current)) {
          continue;
        }
        semanticVisited.add(current);
        component.add(current);
        for (const next of semanticAdjacent.get(current) ?? []) {
          if (!semanticVisited.has(next) && !consumedOpenNumbers.has(next)) {
            queue.push(next);
          }
        }
      }

      const mergedRows = Array.from(component).flatMap(
        (prNumber) => semanticMergedBySeed.get(prNumber) ?? [],
      );
      if (component.size <= 1 && mergedRows.length === 0) {
        continue;
      }

      const openMembers = (
        await Promise.all(
          Array.from(component).map((prNumber) =>
            this.getOrBuildPriorityCandidate(prNumber, repoKey, candidateCache),
          ),
        )
      ).filter((member): member is PriorityCandidate => Boolean(member));
      if (openMembers.length === 0) {
        continue;
      }

      const clusterKey = `semantic:${openMembers
        .map((member) => member.pr.prNumber)
        .sort((left, right) => left - right)
        .join(",")}`;
      const allStateRows = [
        ...openMembers.map((member) => ({
          prNumber: member.pr.prNumber,
          state: member.pr.state,
          updatedAt: member.pr.updatedAt,
        })),
        ...mergedRows,
      ].filter(
        (row, index, rows) =>
          rows.findIndex((candidateRow) => candidateRow.prNumber === row.prNumber) === index,
      );
      clusterSummaries.push(
        this.buildPriorityClusterSummary({
          clusterKey,
          basis: "semantic_only",
          issueNumbers: [],
          openMembers,
          allStateRows,
          representativeHints: new Set<number>(),
        }),
      );
      for (const member of openMembers) {
        consumedOpenNumbers.add(member.pr.prNumber);
      }
    }

    const items: PriorityInboxItem[] = [
      ...clusterSummaries.map(
        (cluster) => ({ kind: "cluster", cluster }) satisfies PriorityInboxItem,
      ),
      ...prioritized
        .filter((candidate) => !consumedOpenNumbers.has(candidate.pr.prNumber))
        .map((candidate) => ({ kind: "pr", candidate }) satisfies PriorityInboxItem),
    ];

    return items
      .sort((left, right) => {
        const leftScore = left.kind === "cluster" ? left.cluster.score : left.candidate.score;
        const rightScore = right.kind === "cluster" ? right.cluster.score : right.candidate.score;
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        const leftUpdatedAt =
          left.kind === "cluster"
            ? left.cluster.representative.pr.updatedAt
            : left.candidate.pr.updatedAt;
        const rightUpdatedAt =
          right.kind === "cluster"
            ? right.cluster.representative.pr.updatedAt
            : right.candidate.pr.updatedAt;
        return rightUpdatedAt.localeCompare(leftUpdatedAt);
      })
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
          this.enrichPriorityCandidate(this.buildPriorityCandidateBase(row, repoKey), { repoKey }),
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
      { repoKey },
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
    const cluster = this.filterVisibleClusterAnalysis(
      repoKey,
      await this.clusterPullRequest({
        prNumber,
        limit: 5,
        ftsOnly: true,
        repoKey,
      }),
    );
    const relatedPullRequests = new Map<number, SearchResult>();
    for (const relatedPullRequest of this.filterVisibleSearchResults(
      repoKey,
      await this.findRelatedPullRequests(prNumber, 5, {
        ftsOnly: true,
      }),
    )) {
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
        repoKey,
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

  private async ensurePullRequestSummaryCached(
    repo: RepoRef,
    source: PullRequestDataSource,
    prNumber: number,
    refresh = false,
  ): Promise<void> {
    const hasPrRow = this.getPrRow(prNumber) !== null;
    if (!hasPrRow || refresh) {
      if (source.getPullRequestSummary) {
        this.upsertPullRequestSummary(
          await source.getPullRequestSummary(repo, prNumber),
          "partial",
        );
        return;
      }
      const hydrated = await source.hydratePullRequest(repo, prNumber);
      this.upsertPullRequestSummary(hydrated.pr, "partial");
    }
  }

  private async ensurePullRequestFactsCached(
    repo: RepoRef,
    source: PullRequestDataSource,
    prNumber: number,
    refresh = false,
  ): Promise<void> {
    if (!source.fetchPullRequestFacts) {
      return;
    }
    const facts = await this.getPullRequestFacts(prNumber);
    if (!facts || refresh) {
      await this.recordPullRequestFacts(await source.fetchPullRequestFacts(repo, prNumber));
    }
  }

  private async ensureClusterCandidateCached(
    repo: RepoRef,
    source: PullRequestDataSource,
    prNumber: number,
    refresh = false,
  ): Promise<void> {
    await this.ensurePullRequestSummaryCached(repo, source, prNumber, refresh);
    await this.ensurePullRequestFactsCached(repo, source, prNumber, refresh);
  }

  private loadClusterInputs(prNumbers: number[]): Map<number, ClusterInputBundle> {
    const uniqueNumbers = Array.from(new Set(prNumbers)).sort((a, b) => a - b);
    const bundles = new Map<number, ClusterInputBundle>();
    if (uniqueNumbers.length === 0) {
      return bundles;
    }

    const placeholders = uniqueNumbers.map(() => "?").join(", ");
    const prRows = this.db
      .prepare(`SELECT * FROM prs WHERE number IN (${placeholders})`)
      .all(...uniqueNumbers) as PrRow[];
    const factRows = this.db
      .prepare(
        `SELECT pr_number, head_sha
           FROM pr_fact_snapshots
          WHERE pr_number IN (${placeholders})`,
      )
      .all(...uniqueNumbers) as Array<{ pr_number: number; head_sha: string }>;
    const linkedIssueRows = this.db
      .prepare(
        `SELECT pr_number, issue_number
           FROM pr_linked_issues
          WHERE pr_number IN (${placeholders})
          ORDER BY pr_number ASC, issue_number ASC`,
      )
      .all(...uniqueNumbers) as Array<{ pr_number: number; issue_number: number }>;
    const changedFileRows = this.db
      .prepare(
        `SELECT pr_number, path, kind
           FROM pr_changed_files
          WHERE pr_number IN (${placeholders})
          ORDER BY pr_number ASC, path ASC`,
      )
      .all(...uniqueNumbers) as Array<{
      pr_number: number;
      path: string;
      kind: PullRequestChangedFile["kind"];
    }>;

    for (const pr of prRows) {
      bundles.set(pr.number, {
        pr,
        headSha: null,
        linkedIssues: [],
        changedFiles: [],
      });
    }
    for (const factRow of factRows) {
      const bundle = bundles.get(factRow.pr_number);
      if (bundle) {
        bundle.headSha = factRow.head_sha;
      }
    }
    for (const linkedIssueRow of linkedIssueRows) {
      const bundle = bundles.get(linkedIssueRow.pr_number);
      if (!bundle) {
        continue;
      }
      const lastIssue = bundle.linkedIssues.at(-1);
      if (lastIssue !== linkedIssueRow.issue_number) {
        bundle.linkedIssues.push(linkedIssueRow.issue_number);
      }
    }
    for (const changedFileRow of changedFileRows) {
      const bundle = bundles.get(changedFileRow.pr_number);
      if (!bundle) {
        continue;
      }
      bundle.changedFiles.push({
        path: changedFileRow.path,
        kind: changedFileRow.kind,
      });
    }
    return bundles;
  }

  private buildClusterCandidateFromBundle(
    bundle: ClusterInputBundle | null,
    status: ClusterCandidate["status"],
    matchedBy: ClusterMatchSource,
    reason?: string,
    reasonCodes: ClusterReasonCode[] = [],
    semanticScore?: number,
    supersededBy?: number,
  ): ClusterCandidate | null {
    if (!bundle) {
      return null;
    }
    return withClusterFeatures(
      {
        prNumber: bundle.pr.number,
        title: bundle.pr.title,
        url: bundle.pr.url,
        state: bundle.pr.state,
        updatedAt: bundle.pr.updated_at,
        matchedBy,
        headSha: bundle.headSha,
        linkedIssues: bundle.linkedIssues,
        prodFiles: bundle.changedFiles
          .filter((file) => file.kind === "prod")
          .map((file) => file.path),
        testFiles: bundle.changedFiles
          .filter((file) => file.kind === "test")
          .map((file) => file.path),
        otherFiles: bundle.changedFiles
          .filter((file) => file.kind === "other")
          .map((file) => file.path),
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

  async refreshPullRequestDetail(
    repo: RepoRef,
    source: PullRequestDataSource,
    prNumber: number,
  ): Promise<void> {
    await this.init();
    const hydrated = await source.hydratePullRequest(repo, prNumber);
    await this.upsertHydratedPullRequest(hydrated, { indexVectors: false });
    await this.ensurePullRequestFactsCached(repo, source, prNumber, true);
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
    return this.buildClusterCandidateFromBundle(
      this.loadClusterInputs([prNumber]).get(prNumber) ?? null,
      status,
      matchedBy,
      reason,
      reasonCodes,
      semanticScore,
      supersededBy,
    );
  }

  private collectLocalPathOverlapCandidates(
    seedPrNumber: number,
    limit: number,
  ): Map<number, ClusterMatchSource> {
    const seedTerms = this.db
      .prepare(
        `SELECT term_kind, term_value
           FROM pr_changed_file_terms
          WHERE pr_number = ?
          ORDER BY term_kind ASC, term_value ASC`,
      )
      .all(seedPrNumber) as Array<{ term_kind: "stem" | "dir" | "dir_pair"; term_value: string }>;
    if (seedTerms.length === 0) {
      return new Map();
    }

    const condition = seedTerms.map(() => "(term_kind = ? AND term_value = ?)").join(" OR ");
    const termParams = seedTerms.flatMap((term) => [term.term_kind, term.term_value]);
    const countRows = this.db
      .prepare(
        `SELECT term_kind, term_value, COUNT(DISTINCT pr_number) AS doc_count
           FROM pr_changed_file_terms
          WHERE ${condition}
          GROUP BY term_kind, term_value`,
      )
      .all(...termParams) as Array<{
      term_kind: "stem" | "dir" | "dir_pair";
      term_value: string;
      doc_count: number;
    }>;
    const kindWeights = {
      stem: 3,
      dir_pair: 2,
      dir: 1,
    } as const;
    const seedTermWeights = countRows
      .filter((row) => row.doc_count <= 40)
      .map((row) => ({
        key: `${row.term_kind}:${row.term_value}`,
        kind: row.term_kind,
        value: row.term_value,
        weight: kindWeights[row.term_kind] / Math.max(1, row.doc_count),
      }))
      .sort((left, right) => right.weight - left.weight || left.key.localeCompare(right.key))
      .slice(0, 10);
    if (seedTermWeights.length === 0) {
      return new Map();
    }

    const selectedCondition = seedTermWeights
      .map(() => "(term_kind = ? AND term_value = ?)")
      .join(" OR ");
    const selectedParams = seedTermWeights.flatMap((term) => [term.kind, term.value]);
    const overlapRows = this.db
      .prepare(
        `SELECT pr_number, term_kind, term_value
           FROM pr_changed_file_terms
          WHERE pr_number != ?
            AND (${selectedCondition})`,
      )
      .all(seedPrNumber, ...selectedParams) as Array<{
      pr_number: number;
      term_kind: "stem" | "dir" | "dir_pair";
      term_value: string;
    }>;
    const scoreByPr = new Map<number, number>();
    const weightByKey = new Map(seedTermWeights.map((term) => [term.key, term.weight]));
    for (const row of overlapRows) {
      const key = `${row.term_kind}:${row.term_value}`;
      scoreByPr.set(
        row.pr_number,
        (scoreByPr.get(row.pr_number) ?? 0) + (weightByKey.get(key) ?? 0),
      );
    }

    return new Map(
      Array.from(scoreByPr.entries())
        .sort((left, right) => right[1] - left[1] || right[0] - left[0])
        .slice(0, limit)
        .map(([prNumber]) => [prNumber, "local_semantic" satisfies ClusterMatchSource]),
    );
  }

  private async rerankSemanticCandidates(params: {
    seed: { title: string; body: string; changedFiles: PullRequestChangedFile[] };
    candidates: ClusterCandidate[];
  }): Promise<ClusterCandidate[]> {
    if (params.candidates.length === 0) {
      return params.candidates;
    }
    const rerankable = [...params.candidates]
      .sort(
        (left, right) =>
          (right.semanticScore ?? 0) - (left.semanticScore ?? 0) ||
          right.updatedAt.localeCompare(left.updatedAt),
      )
      .slice(0, CLUSTER_EMBEDDING_RERANK_LIMIT);
    const seedText = buildClusterSemanticText(params.seed);
    const entries = [
      {
        key: `seed`,
        hash: hashText(seedText),
        text: seedText,
      },
      ...rerankable.map((candidate) => {
        const candidateText = buildClusterSemanticText({
          title: candidate.title,
          body: "",
          changedFiles: [
            ...candidate.prodFiles.map(
              (path) => ({ path, kind: "prod" }) satisfies PullRequestChangedFile,
            ),
            ...candidate.testFiles.map(
              (path) => ({ path, kind: "test" }) satisfies PullRequestChangedFile,
            ),
            ...candidate.otherFiles.map(
              (path) => ({ path, kind: "other" }) satisfies PullRequestChangedFile,
            ),
          ],
        });
        return {
          key: String(candidate.prNumber),
          hash: hashText(candidateText),
          text: candidateText,
        };
      }),
    ];
    const embeddings = await this.embedTextEntries(
      CLUSTER_EMBEDDING_PROVIDER,
      entries.map((entry) => ({ hash: entry.hash, text: entry.text })),
    );
    const seedEmbedding = embeddings.get(entries[0]!.hash);
    if (!seedEmbedding?.length) {
      return params.candidates;
    }

    const cosineSimilarity = (left: number[], right: number[]): number => {
      let sum = 0;
      const dims = Math.min(left.length, right.length);
      for (let index = 0; index < dims; index += 1) {
        sum += (left[index] ?? 0) * (right[index] ?? 0);
      }
      return sum;
    };

    const rerankedByPr = new Map<number, ClusterCandidate>();
    for (const candidate of rerankable) {
      const entry = entries.find((value) => value.key === String(candidate.prNumber));
      if (!entry) {
        continue;
      }
      const candidateEmbedding = embeddings.get(entry.hash);
      if (!candidateEmbedding?.length) {
        continue;
      }
      const score = computeSemanticScore({
        seed: params.seed,
        candidate: {
          title: candidate.title,
          body: "",
          changedFiles: [
            ...candidate.prodFiles.map(
              (path) => ({ path, kind: "prod" }) satisfies PullRequestChangedFile,
            ),
            ...candidate.testFiles.map(
              (path) => ({ path, kind: "test" }) satisfies PullRequestChangedFile,
            ),
            ...candidate.otherFiles.map(
              (path) => ({ path, kind: "other" }) satisfies PullRequestChangedFile,
            ),
          ],
        },
        embeddingScore: cosineSimilarity(seedEmbedding, candidateEmbedding),
      });
      rerankedByPr.set(
        candidate.prNumber,
        withClusterFeatures(
          {
            ...candidate,
            semanticScore: score.score,
          },
          [],
        ),
      );
    }

    return params.candidates.map((candidate) => rerankedByPr.get(candidate.prNumber) ?? candidate);
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

  private buildLinkedIssueClusterCacheKey(
    repoKey: string,
    clusterIssueNumbers: number[],
    bundles: Map<number, ClusterInputBundle>,
  ): string {
    const issueKey = [...clusterIssueNumbers].sort((left, right) => left - right).join(",");
    const memberSignature = Array.from(bundles.values())
      .sort((left, right) => left.pr.number - right.pr.number)
      .map((bundle) => `${bundle.pr.number}@${bundle.headSha ?? bundle.pr.updated_at}`)
      .join("|");
    return `${repoKey}:${issueKey}:${memberSignature}`;
  }

  private async computeLinkedIssueClusterEvaluation(params: {
    seed: PrRow;
    clusterIssueNumbers: number[];
    liveIssueSearchLimit: number;
    limit: number;
    repoKey: string;
    repo?: RepoRef;
    source?: PullRequestDataSource;
    refresh?: boolean;
  }): Promise<CachedLinkedIssueClusterEvaluation> {
    let exactMatches = new Map<number, ClusterMatchSource>([[params.seed.number, "linked_issue"]]);
    for (const prNumber of this.findPullRequestsByLinkedIssues(params.clusterIssueNumbers)) {
      exactMatches.set(prNumber, "linked_issue");
    }

    let bundles = this.loadClusterInputs(Array.from(exactMatches.keys()));
    const initialCacheKey = this.buildLinkedIssueClusterCacheKey(
      params.repoKey,
      params.clusterIssueNumbers,
      bundles,
    );
    const cached = !params.refresh ? this.linkedIssueClusterCache.get(initialCacheKey) : undefined;
    if (cached) {
      return cached;
    }

    if (params.repo && params.source) {
      const liveIssueMatches = await this.collectLiveIssueSearchCandidates(
        params.repo,
        params.source,
        params.clusterIssueNumbers,
        params.liveIssueSearchLimit,
      );
      for (const [prNumber, matchedBy] of liveIssueMatches) {
        await this.ensureClusterCandidateCached(
          params.repo,
          params.source,
          prNumber,
          params.refresh ?? false,
        );
        const linkedIssues = this.getLinkedIssuesForPr(prNumber).map((issue) => issue.issueNumber);
        if (linkedIssues.some((issue) => params.clusterIssueNumbers.includes(issue))) {
          exactMatches.set(prNumber, exactMatches.get(prNumber) ?? matchedBy);
        }
      }
    }

    for (const prNumber of this.findPullRequestsByLinkedIssues(params.clusterIssueNumbers)) {
      exactMatches.set(prNumber, exactMatches.get(prNumber) ?? "linked_issue");
    }

    bundles = this.loadClusterInputs(Array.from(exactMatches.keys()));
    const rawCandidates = Array.from(exactMatches.entries())
      .map(([prNumber, matchedBy]) =>
        this.buildClusterCandidateFromBundle(
          bundles.get(prNumber) ?? null,
          "same_cluster_candidate",
          matchedBy,
          matchedBy === "live_issue_search" ? "discovered via live issue search" : undefined,
          matchedBy === "live_issue_search"
            ? ["same_linked_issue", "discovered_via_live_issue_search"]
            : ["same_linked_issue"],
        ),
      )
      .filter((candidate): candidate is ClusterCandidate => Boolean(candidate));
    const cappedCandidates = [...rawCandidates]
      .sort((left, right) => {
        const issueDelta =
          right.linkedIssues.filter((issue) => params.clusterIssueNumbers.includes(issue)).length -
          left.linkedIssues.filter((issue) => params.clusterIssueNumbers.includes(issue)).length;
        if (issueDelta !== 0) {
          return issueDelta;
        }
        const stateRank = (value: ClusterCandidate["state"]): number =>
          value === "open" ? 2 : value === "merged" ? 1 : 0;
        const stateDelta = stateRank(right.state) - stateRank(left.state);
        if (stateDelta !== 0) {
          return stateDelta;
        }
        return right.updatedAt.localeCompare(left.updatedAt) || right.prNumber - left.prNumber;
      })
      .slice(0, EXACT_CLUSTER_PATH_CAP);
    const relevantPaths = buildRelevantPathSets(params.seed.number, cappedCandidates);
    const rankedCandidates = cappedCandidates
      .map((candidate) =>
        annotateRelevantCoverage(
          candidate,
          relevantPaths.relevantProdFiles,
          relevantPaths.relevantTestFiles,
          params.clusterIssueNumbers,
        ),
      )
      .sort((left, right) => rankClusterCandidates(params.clusterIssueNumbers, left, right));
    const rankedDecisionSet = rankClusterDecisionSet({
      rankedCandidates,
      limit: params.limit,
    });
    const decisionTrace = [
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
      ...rankedDecisionSet.decisionTrace,
    ];
    const cacheEntry: CachedLinkedIssueClusterEvaluation = {
      clusterIssueNumbers: [...params.clusterIssueNumbers],
      decisionTrace,
      rankedCandidates,
      relevantPaths,
      bestBase: rankedDecisionSet.bestBase,
      sameClusterCandidates: rankedDecisionSet.sameClusterCandidates,
    };
    this.linkedIssueClusterCache.set(
      this.buildLinkedIssueClusterCacheKey(params.repoKey, params.clusterIssueNumbers, bundles),
      cacheEntry,
    );
    return cacheEntry;
  }

  private async collectLinkedIssueCandidateSet(params: {
    seed: PrRow;
    clusterIssueNumbers: number[];
    liveIssueSearchLimit: number;
    limit: number;
    repoKey: string;
    repo?: RepoRef;
    source?: PullRequestDataSource;
    refresh?: boolean;
  }): Promise<CachedLinkedIssueClusterEvaluation> {
    return this.computeLinkedIssueClusterEvaluation(params);
  }

  private async collectSemanticOnlyDecisionSet(params: {
    seed: PrRow;
    semanticNumbers: Map<number, ClusterMatchSource>;
    repo?: RepoRef;
    source?: PullRequestDataSource;
    refresh?: boolean;
  }): Promise<{
    sameClusterCandidates: ClusterCandidate[];
    nearbyButExcluded: ClusterExcludedCandidate[];
    decisionTrace: ClusterDecisionTrace[];
  }> {
    const sameClusterCandidates: ClusterCandidate[] = [];
    const nearbyButExcluded: ClusterExcludedCandidate[] = [];
    const decisionTrace: ClusterDecisionTrace[] = [];
    const seedChangedFiles = this.getChangedFilesForPr(params.seed.number);
    const semanticNumbers = Array.from(params.semanticNumbers.entries());

    if (params.repo && params.source) {
      for (const [prNumber] of semanticNumbers) {
        await this.ensureClusterCandidateCached(
          params.repo,
          params.source,
          prNumber,
          params.refresh ?? false,
        );
      }
    }
    const bundles = this.loadClusterInputs(semanticNumbers.map(([prNumber]) => prNumber));
    const semanticCandidates = semanticNumbers.flatMap(([prNumber, matchedBy]) => {
      const bundle = bundles.get(prNumber);
      if (!bundle) {
        return [];
      }
      const semanticScore = computeSemanticScore({
        seed: {
          title: params.seed.title,
          body: params.seed.body,
          changedFiles: seedChangedFiles,
        },
        candidate: {
          title: bundle.pr.title,
          body: bundle.pr.body,
          changedFiles: bundle.changedFiles,
        },
      });
      const candidate = this.buildClusterCandidateFromBundle(
        bundle,
        "possible_same_cluster",
        matchedBy,
        undefined,
        ["semantic_only_candidate"],
        semanticScore.score,
      );
      return candidate ? [candidate] : [];
    });
    const rerankedCandidates = await this.rerankSemanticCandidates({
      seed: {
        title: params.seed.title,
        body: params.seed.body,
        changedFiles: seedChangedFiles,
      },
      candidates: semanticCandidates,
    });

    for (const candidate of rerankedCandidates) {
      const evaluation = evaluateSemanticOnlyCandidate(candidate);
      decisionTrace.push(...evaluation.decisionTrace);
      if (evaluation.included) {
        sameClusterCandidates.push(evaluation.included);
        continue;
      }
      if (evaluation.excluded) {
        nearbyButExcluded.push(evaluation.excluded);
      }
    }

    return {
      sameClusterCandidates,
      nearbyButExcluded,
      decisionTrace,
    };
  }

  private async collectNearbyExcludedCandidates(params: {
    seed: PrRow;
    nearbyNumbers: Map<number, ClusterMatchSource>;
    sameClusterSet: Set<number>;
    relevantPaths: {
      relevantProdFiles: Set<string>;
      relevantTestFiles: Set<string>;
    };
    clusterIssueNumbers: number[];
    repo?: RepoRef;
    source?: PullRequestDataSource;
    refresh?: boolean;
  }): Promise<{
    nearbyButExcluded: ClusterExcludedCandidate[];
    decisionTrace: ClusterDecisionTrace[];
  }> {
    const nearbyButExcluded: ClusterExcludedCandidate[] = [];
    const decisionTrace: ClusterDecisionTrace[] = [];
    const seedChangedFiles = this.getChangedFilesForPr(params.seed.number);
    const nearbyNumbers = Array.from(params.nearbyNumbers.entries()).filter(
      ([prNumber]) => !params.sameClusterSet.has(prNumber),
    );

    if (params.repo && params.source) {
      for (const [prNumber] of nearbyNumbers) {
        await this.ensureClusterCandidateCached(
          params.repo,
          params.source,
          prNumber,
          params.refresh ?? false,
        );
      }
    }
    const bundles = this.loadClusterInputs(nearbyNumbers.map(([prNumber]) => prNumber));
    const nearbyCandidates = nearbyNumbers.flatMap(([prNumber, matchedBy]) => {
      const bundle = bundles.get(prNumber) ?? null;
      if (!bundle) {
        return [];
      }
      const semanticScore = computeSemanticScore({
        seed: {
          title: params.seed.title,
          body: params.seed.body,
          changedFiles: seedChangedFiles,
        },
        candidate: {
          title: bundle.pr.title,
          body: bundle.pr.body,
          changedFiles: bundle.changedFiles,
        },
      });
      const candidate = this.buildClusterCandidateFromBundle(
        bundle,
        "same_cluster_candidate",
        matchedBy,
        undefined,
        [],
        semanticScore.score,
      );
      return candidate ? [candidate] : [];
    });
    const rerankedCandidates = await this.rerankSemanticCandidates({
      seed: {
        title: params.seed.title,
        body: params.seed.body,
        changedFiles: seedChangedFiles,
      },
      candidates: nearbyCandidates,
    });

    for (const candidate of rerankedCandidates) {
      const annotated = annotateRelevantCoverage(
        candidate,
        params.relevantPaths.relevantProdFiles,
        params.relevantPaths.relevantTestFiles,
        params.clusterIssueNumbers,
      );
      const excluded = classifyNearbyExcludedCandidate({
        candidate: annotated,
        clusterIssueNumbers: params.clusterIssueNumbers,
      });
      nearbyButExcluded.push(excluded);
      decisionTrace.push(buildExcludedTrace(excluded));
    }

    return {
      nearbyButExcluded,
      decisionTrace,
    };
  }

  private resolveMergeReadiness(
    candidate: ClusterCandidate | null,
    repoKey: string | null = null,
  ): MergeReadiness | null {
    if (!candidate) {
      return null;
    }
    const repo = repoKey ?? this.getMeta(META_REPO) ?? "";
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
    repoKey?: string;
    source?: PullRequestDataSource;
    refresh?: boolean;
  }): Promise<ClusterPullRequestAnalysis | null> {
    await this.init();
    await this.ensureDerivedIssueLinksBackfilled();
    await this.ensureChangedFileTermsBackfilled();
    const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;
    if (params.repo && params.source) {
      await this.ensureClusterCandidateCached(
        params.repo,
        params.source,
        params.prNumber,
        params.refresh ?? false,
      );
    }
    const seed = this.getPrRow(params.prNumber);
    if (!seed) {
      return null;
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
    for (const [prNumber, matchedBy] of this.collectLocalPathOverlapCandidates(
      params.prNumber,
      CLUSTER_LOCAL_PATH_LIMIT,
    )) {
      if (prNumber !== params.prNumber) {
        localNearbyNumbers.set(prNumber, localNearbyNumbers.get(prNumber) ?? matchedBy);
      }
    }

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
      const semanticDecisionSet = await this.collectSemanticOnlyDecisionSet({
        seed,
        semanticNumbers,
        repo: params.repo,
        source: params.source,
        refresh: params.refresh ?? false,
      });
      const sameClusterCandidates = semanticDecisionSet.sameClusterCandidates;
      const nearbyButExcluded = semanticDecisionSet.nearbyButExcluded;
      decisionTrace.push(...semanticDecisionSet.decisionTrace);
      const orderedCandidates = orderSemanticOnlyCandidates(sameClusterCandidates, limit);
      return buildSemanticOnlyClusterResult({
        seed,
        sameClusterCandidates: orderedCandidates,
        nearbyButExcluded,
        decisionTrace,
        limit,
      });
    }

    const linkedIssueCandidateSet = await this.collectLinkedIssueCandidateSet({
      seed,
      clusterIssueNumbers: seedLinkedIssues,
      liveIssueSearchLimit: limit * 3,
      limit,
      repoKey:
        params.repoKey ??
        (params.repo ? this.repoKey(params.repo) : (this.getMeta(META_REPO) ?? "")),
      repo: params.repo,
      source: params.source,
      refresh: params.refresh ?? false,
    });
    const decisionTrace = [
      buildClusterDecisionTrace({
        phase: "seed",
        prNumber: seed.number,
        matchedBy: null,
        outcome: "linked_issue_seed",
        summary: `Seed PR links issues ${seedLinkedIssues.map((issue) => `#${issue}`).join(", ")}.`,
      }),
      ...linkedIssueCandidateSet.decisionTrace,
    ];
    const bestBase = linkedIssueCandidateSet.bestBase;
    const sameClusterCandidates = linkedIssueCandidateSet.sameClusterCandidates;

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

    const sameClusterSet = new Set(
      linkedIssueCandidateSet.rankedCandidates.map((candidate) => candidate.prNumber),
    );
    const nearbyDecisionSet = await this.collectNearbyExcludedCandidates({
      seed,
      nearbyNumbers,
      sameClusterSet,
      relevantPaths: linkedIssueCandidateSet.relevantPaths,
      clusterIssueNumbers: seedLinkedIssues,
      repo: params.repo,
      source: params.source,
      refresh: params.refresh ?? false,
    });
    const nearbyButExcluded = nearbyDecisionSet.nearbyButExcluded;
    decisionTrace.push(...nearbyDecisionSet.decisionTrace);
    return buildLinkedIssueClusterResult({
      seed,
      clusterIssueNumbers: seedLinkedIssues,
      bestBase,
      sameClusterCandidates,
      nearbyButExcluded,
      mergeReadiness: this.resolveMergeReadiness(
        bestBase,
        params.repoKey ?? (params.repo ? this.repoKey(params.repo) : null),
      ),
      decisionTrace,
      limit,
    });
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
