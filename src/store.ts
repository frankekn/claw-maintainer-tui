import * as path from "node:path";
import { runTasksWithConcurrency } from "./lib/concurrency.js";
import { buildFtsQuery, bm25RankToScore } from "./lib/hybrid.js";
import { ensureDir, hashText } from "./lib/internal.js";
import { loadSqliteVecExtension } from "./lib/sqlite-vec.js";
import { requireNodeSqlite } from "./lib/sqlite.js";
import { truncateUtf16Safe } from "./lib/text.js";
import {
  createLocalEmbeddingProvider,
  DEFAULT_GH_INTEL_LOCAL_MODEL,
  type LocalEmbeddingProvider,
} from "./embedding.js";
import type {
  ClusterCandidate,
  ClusterExcludedCandidate,
  ClusterExcludedReasonCode,
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
  PullRequestReviewFact,
  ReviewFactDecision,
  RepoRef,
  SemanticCorpusDocument,
  SearchDocument,
  SearchFilters,
  SearchResult,
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
const XREF_STOP_WORDS = new Set([
  "after",
  "again",
  "content",
  "issue",
  "message",
  "still",
  "their",
  "there",
  "users",
  "using",
]);
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
const FAILING_CHECK_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "CANCELLED",
]);

type PrRow = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  is_draft: number;
  author: string;
  base_ref: string;
  head_ref: string;
  url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
};

type SearchDocRow = {
  doc_id: string;
  pr_number: number;
  doc_kind: "pr_body" | "comment";
  title: string;
  text: string;
  updated_at: string;
  score: number;
};

type IssueRow = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author: string;
  url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

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

function toVectorBlob(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

function normalizeSearchText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function buildCrossReferenceQuery(title: string, body: string): string {
  const normalizedBody = normalizeSearchText(body);
  const firstSentence = normalizedBody
    .split(/[\n.!?]+/g)
    .map((value) => value.trim())
    .find(Boolean);
  const source =
    firstSentence && firstSentence.length >= 24 ? firstSentence : title || normalizedBody;
  const terms = Array.from(
    new Set(
      (source.match(/[\p{L}\p{N}_]+/gu) ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length >= 5 && !XREF_STOP_WORDS.has(value.toLowerCase())),
    ),
  )
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .slice(0, 4);
  if (terms.length > 0) {
    return terms.join(" ");
  }
  return normalizeSearchText(title) || normalizedBody;
}

function isoNow(): string {
  return new Date().toISOString();
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function addIssueLink(
  out: Map<number, PullRequestLinkedIssue>,
  issueNumber: number,
  linkSource: PullRequestLinkSource,
): void {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return;
  }
  const existing = out.get(issueNumber);
  if (!existing || linkSource === "closing_reference") {
    out.set(issueNumber, { issueNumber, linkSource });
  }
}

function parseIssueLinksFromPrText(title: string, body: string): PullRequestLinkedIssue[] {
  const out = new Map<number, PullRequestLinkedIssue>();
  for (const match of title.matchAll(/\[issue\s+#(\d+)\]/gi)) {
    addIssueLink(out, Number(match[1]), "title_reference");
  }
  for (const match of body.matchAll(/\bsource issue\s*#(\d+)\b/gi)) {
    addIssueLink(out, Number(match[1]), "source_issue_marker");
  }
  for (const match of body.matchAll(/\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/gi)) {
    addIssueLink(out, Number(match[1]), "body_reference");
  }
  return Array.from(out.values()).sort((a, b) => a.issueNumber - b.issueNumber);
}

function setContainsAll(left: Set<string>, right: Set<string>): boolean {
  for (const value of right) {
    if (!left.has(value)) {
      return false;
    }
  }
  return true;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right),
  );
}

function getFileStem(filePath: string): string {
  const baseName = path.basename(filePath).toLowerCase();
  return baseName.replace(/\.(test|spec)(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, "");
}

function isCompanionTest(prodPath: string, testPath: string): boolean {
  const prodStem = getFileStem(prodPath);
  const testStem = getFileStem(testPath);
  if (!prodStem || !testStem || prodStem !== testStem) {
    return false;
  }
  const prodDir = path.dirname(prodPath);
  const testDir = path.dirname(testPath);
  return testDir === prodDir || testDir.endsWith(prodDir) || prodDir.endsWith(testDir);
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

function dedupeCheckNames(names: string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([name, count]) => (count > 1 ? `${name} (x${count})` : name));
}

function normalizeClusterSearchTitle(title: string): string {
  return title.replace(/^[a-z0-9_-]+(?:\([^)]*\))?:\s*/i, "").trim();
}

function extractSemanticTerms(...values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .flatMap((value) => normalizeSearchText(value).match(/[\p{L}\p{N}_-]+/gu) ?? [])
        .map((value) => value.toLowerCase())
        .filter((value) => value.length >= 4 && !XREF_STOP_WORDS.has(value)),
    ),
  ).sort((left, right) => right.length - left.length || left.localeCompare(right));
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

function parseQuotedValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  let remaining = raw.trim();
  const filters: SearchFilters = { labels: [] };

  remaining = remaining.replace(/#(\d+)/g, (_, value: string) => {
    filters.prNumber = Number(value);
    return " ";
  });

  remaining = remaining.replace(/label:(".*?"|\S+)/g, (_, value: string) => {
    filters.labels.push(parseQuotedValue(value));
    return " ";
  });

  remaining = remaining.replace(/state:(open|closed|merged|all)\b/gi, (_, value: string) => {
    filters.state = value.toLowerCase() as SearchFilters["state"];
    return " ";
  });

  remaining = remaining.replace(/author:(\S+)/gi, (_, value: string) => {
    filters.author = value.trim();
    return " ";
  });

  remaining = remaining.replace(/branch:(\S+)/gi, (_, value: string) => {
    filters.branch = value.trim();
    return " ";
  });

  filters.labels = uniqueSorted(filters.labels);
  return {
    raw,
    text: remaining.replace(/\s+/g, " ").trim(),
    filters,
  };
}

export function parseIssueSearchQuery(raw: string): {
  raw: string;
  text: string;
  filters: IssueSearchFilters;
} {
  let remaining = raw.trim();
  const filters: IssueSearchFilters = { labels: [] };

  remaining = remaining.replace(/#(\d+)/g, (_, value: string) => {
    filters.issueNumber = Number(value);
    return " ";
  });

  remaining = remaining.replace(/label:(".*?"|\S+)/g, (_, value: string) => {
    filters.labels.push(parseQuotedValue(value));
    return " ";
  });

  remaining = remaining.replace(/state:(open|closed|all)\b/gi, (_, value: string) => {
    filters.state = value.toLowerCase() as IssueSearchFilters["state"];
    return " ";
  });

  remaining = remaining.replace(/author:(\S+)/gi, (_, value: string) => {
    filters.author = value.trim();
    return " ";
  });

  filters.labels = uniqueSorted(filters.labels);
  return {
    raw,
    text: remaining.replace(/\s+/g, " ").trim(),
    filters,
  };
}

function buildPrFilterClause(
  filters: SearchFilters,
  prAlias: string,
): { sql: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filters.prNumber !== undefined) {
    clauses.push(`${prAlias}.number = ?`);
    params.push(filters.prNumber);
  }
  if (filters.state && filters.state !== "all") {
    clauses.push(`${prAlias}.state = ?`);
    params.push(filters.state);
  }
  if (filters.author) {
    clauses.push(`${prAlias}.author = ?`);
    params.push(filters.author);
  }
  if (filters.branch) {
    clauses.push(`${prAlias}.head_ref = ?`);
    params.push(filters.branch);
  }
  for (const label of filters.labels) {
    clauses.push(
      `EXISTS (SELECT 1 FROM pr_labels label_filter WHERE label_filter.pr_number = ${prAlias}.number AND label_filter.label_name = ?)`,
    );
    params.push(label);
  }

  return {
    sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function buildIssueFilterClause(
  filters: IssueSearchFilters,
  issueAlias: string,
): { sql: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filters.issueNumber !== undefined) {
    clauses.push(`${issueAlias}.number = ?`);
    params.push(filters.issueNumber);
  }
  if (filters.state && filters.state !== "all") {
    clauses.push(`${issueAlias}.state = ?`);
    params.push(filters.state);
  }
  if (filters.author) {
    clauses.push(`${issueAlias}.author = ?`);
    params.push(filters.author);
  }
  for (const label of filters.labels) {
    clauses.push(
      `EXISTS (SELECT 1 FROM issue_labels label_filter WHERE label_filter.issue_number = ${issueAlias}.number AND label_filter.label_name = ?)`,
    );
    params.push(label);
  }

  return {
    sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
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
    for (const issue of parseIssueLinksFromPrText(title, body)) {
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
        this.db
          .prepare(
            `INSERT INTO prs (
              number, title, body, state, is_draft, author, base_ref, head_ref, url,
              created_at, updated_at, closed_at, merged_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(number) DO UPDATE SET
              title = excluded.title,
              body = excluded.body,
              state = excluded.state,
              is_draft = excluded.is_draft,
              author = excluded.author,
              base_ref = excluded.base_ref,
              head_ref = excluded.head_ref,
              url = excluded.url,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              closed_at = excluded.closed_at,
              merged_at = excluded.merged_at`,
          )
          .run(
            payload.pr.number,
            payload.pr.title,
            payload.pr.body,
            payload.pr.state,
            payload.pr.isDraft ? 1 : 0,
            payload.pr.author,
            payload.pr.baseRef,
            payload.pr.headRef,
            payload.pr.url,
            payload.pr.createdAt,
            payload.pr.updatedAt,
            payload.pr.closedAt,
            payload.pr.mergedAt,
          );

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
  }): Promise<SyncSummary> {
    await this.init();
    const mode = params.full || !this.getMeta(META_LAST_SYNC_WATERMARK) ? "full" : "incremental";
    const watermark = this.getMeta(META_LAST_SYNC_WATERMARK);
    const repoName = `${params.repo.owner}/${params.repo.name}`;
    this.setMeta(META_REPO, repoName);

    const toProcess: number[] = [];
    const shallowPullRequests: HydratedPullRequest[] = [];
    let skippedPrs = 0;

    if (mode === "full") {
      for await (const pr of params.source.listAllPullRequests(params.repo)) {
        const existingUpdatedAt = this.getStoredUpdatedAt(pr.number);
        if (existingUpdatedAt === pr.updatedAt) {
          skippedPrs += 1;
          continue;
        }
        if (params.hydrateAll) {
          toProcess.push(pr.number);
        } else {
          shallowPullRequests.push({ pr, comments: [] });
        }
      }
    } else if (watermark) {
      toProcess.push(
        ...(await params.source.listChangedPullRequestNumbersSince(params.repo, watermark)),
      );
    }

    for (const payload of shallowPullRequests) {
      await this.upsertHydratedPullRequest(payload, { indexVectors: false });
    }

    const tasks = toProcess.map((prNumber) => async () => {
      const hydrated = await params.source.hydratePullRequest(params.repo, prNumber);
      await this.upsertHydratedPullRequest(hydrated, { indexVectors: false });
      return prNumber;
    });

    const result = await runTasksWithConcurrency({
      tasks,
      limit: this.syncConcurrency,
      errorMode: "stop",
    });
    if (result.hasError) {
      throw result.firstError;
    }

    const syncedAt = isoNow();
    this.setMeta(META_LAST_SYNC_AT, syncedAt);
    this.setMeta(META_LAST_SYNC_WATERMARK, syncedAt);

    return {
      mode,
      entity: "prs",
      repo: repoName,
      processedPrs: toProcess.length + shallowPullRequests.length,
      processedIssues: 0,
      skippedPrs,
      skippedIssues: 0,
      docCount: this.countRows("search_docs"),
      commentCount: this.countRows("pr_comments"),
      labelCount: this.countRows("pr_labels"),
      vectorAvailable: this.vectorAvailable,
      lastSyncAt: syncedAt,
      lastSyncWatermark: syncedAt,
    };
  }

  async syncIssues(params: {
    repo: RepoRef;
    source: IssueDataSource;
    full?: boolean;
  }): Promise<SyncSummary> {
    await this.init();
    const mode =
      params.full || !this.getMeta(META_ISSUE_LAST_SYNC_WATERMARK) ? "full" : "incremental";
    const watermark = this.getMeta(META_ISSUE_LAST_SYNC_WATERMARK);
    const repoName = `${params.repo.owner}/${params.repo.name}`;
    this.setMeta(META_REPO, repoName);

    const toProcess: number[] = [];
    const shallowIssues: IssueRecord[] = [];
    let skippedIssues = 0;

    if (mode === "full") {
      for await (const issue of params.source.listAllIssues(params.repo)) {
        const existingUpdatedAt = this.getStoredIssueUpdatedAt(issue.number);
        if (existingUpdatedAt === issue.updatedAt) {
          skippedIssues += 1;
          continue;
        }
        shallowIssues.push(issue);
      }
    } else if (watermark) {
      toProcess.push(...(await params.source.listChangedIssueNumbersSince(params.repo, watermark)));
    }

    for (const issue of shallowIssues) {
      this.upsertIssue(issue);
    }

    const tasks = toProcess.map((issueNumber) => async () => {
      const issue = await params.source.getIssue(params.repo, issueNumber);
      this.upsertIssue(issue);
      return issueNumber;
    });

    const result = await runTasksWithConcurrency({
      tasks,
      limit: this.syncConcurrency,
      errorMode: "stop",
    });
    if (result.hasError) {
      throw result.firstError;
    }

    const syncedAt = isoNow();
    this.setMeta(META_ISSUE_LAST_SYNC_AT, syncedAt);
    this.setMeta(META_ISSUE_LAST_SYNC_WATERMARK, syncedAt);

    return {
      mode,
      entity: "issues",
      repo: repoName,
      processedPrs: 0,
      processedIssues: toProcess.length + shallowIssues.length,
      skippedPrs: 0,
      skippedIssues,
      docCount: this.countRows("search_docs"),
      commentCount: this.countRows("pr_comments"),
      labelCount: this.countRows("issue_labels"),
      vectorAvailable: this.vectorAvailable,
      lastSyncAt: syncedAt,
      lastSyncWatermark: syncedAt,
    };
  }

  private countRows(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
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
    const byDoc = new Map<
      string,
      SearchDocRow & {
        vectorScore: number;
        textScore: number;
      }
    >();

    for (const hit of keywordHits) {
      byDoc.set(hit.doc_id, { ...hit, vectorScore: 0, textScore: hit.score });
    }
    for (const hit of vectorHits) {
      const existing = byDoc.get(hit.doc_id);
      if (existing) {
        existing.vectorScore = hit.score;
      } else {
        byDoc.set(hit.doc_id, { ...hit, vectorScore: hit.score, textScore: 0 });
      }
    }

    const ranked = Array.from(byDoc.values())
      .map((row) => ({
        ...row,
        score:
          keywordHits.length > 0
            ? row.textScore > 0
              ? row.textScore
              : row.vectorScore * VECTOR_FALLBACK_WEIGHT
            : row.vectorScore,
      }))
      .sort((a, b) => b.score - a.score);

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
    return results.filter((result) => result.prNumber !== prNumber).slice(0, limit);
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
    return (
      (this.db.prepare("SELECT * FROM prs WHERE number = ?").get(prNumber) as PrRow | undefined) ??
      null
    );
  }

  private getIssueRow(issueNumber: number): IssueRow | null {
    return (
      (this.db.prepare("SELECT * FROM issues WHERE number = ?").get(issueNumber) as
        | IssueRow
        | undefined) ?? null
    );
  }

  private getLinkedIssuesForPr(prNumber: number): PullRequestLinkedIssue[] {
    const rows = this.db
      .prepare(
        `SELECT issue_number, link_source
           FROM pr_linked_issues
          WHERE pr_number = ?
          ORDER BY issue_number ASC, link_source ASC`,
      )
      .all(prNumber) as Array<{ issue_number: number; link_source: PullRequestLinkSource }>;
    const out = new Map<number, PullRequestLinkedIssue>();
    for (const row of rows) {
      addIssueLink(out, row.issue_number, row.link_source);
    }
    return Array.from(out.values()).sort((a, b) => a.issueNumber - b.issueNumber);
  }

  private getChangedFilesForPr(prNumber: number): PullRequestChangedFile[] {
    return this.db
      .prepare(
        `SELECT path, kind
           FROM pr_changed_files
          WHERE pr_number = ?
          ORDER BY path ASC`,
      )
      .all(prNumber) as PullRequestChangedFile[];
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
    return {
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
    };
  }

  private annotateRelevantCoverage(
    candidate: ClusterCandidate,
    relevantProdFiles: Set<string>,
    relevantTestFiles: Set<string>,
  ): ClusterCandidate {
    const relevantProd = candidate.prodFiles.filter((file) => relevantProdFiles.has(file));
    const relevantTest = candidate.testFiles.filter((file) => relevantTestFiles.has(file));
    const noiseFilesCount =
      candidate.prodFiles.length +
      candidate.testFiles.length +
      candidate.otherFiles.length -
      relevantProd.length -
      relevantTest.length;
    return {
      ...candidate,
      relevantProdFiles: relevantProd,
      relevantTestFiles: relevantTest,
      noiseFilesCount,
    };
  }

  private buildRelevantPathSets(
    seedPrNumber: number,
    candidates: ClusterCandidate[],
  ): {
    relevantProdFiles: Set<string>;
    relevantTestFiles: Set<string>;
  } {
    const prodCounts = new Map<string, number>();
    const testCounts = new Map<string, number>();
    const seedCandidate =
      candidates.find((candidate) => candidate.prNumber === seedPrNumber) ?? null;

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

  private buildBestBaseReasonCodes(
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

  private buildSupersededReasonCodes(
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

  private rankClusterCandidates(
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

  private computeSemanticScore(seed: PrRow, candidate: PrRow): number {
    const seedTerms = extractSemanticTerms(
      normalizeClusterSearchTitle(seed.title),
      seed.body,
    ).slice(0, 6);
    if (seedTerms.length === 0) {
      return 0;
    }
    const candidateTerms = new Set(
      extractSemanticTerms(normalizeClusterSearchTitle(candidate.title), candidate.body),
    );
    const matchedTerms = seedTerms.filter((term) => candidateTerms.has(term)).length;
    const seedFiles = new Set(
      this.getChangedFilesForPr(seed.number)
        .filter((file) => file.kind !== "other")
        .map((file) => getFileStem(file.path)),
    );
    const candidateFiles = new Set(
      this.getChangedFilesForPr(candidate.number)
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
    return Math.min(
      1,
      matchedTerms / Math.max(2, Math.min(6, seedTerms.length)) + fileOverlap * 0.3,
    );
  }

  private buildLiveSemanticQueries(seed: PrRow): string[] {
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
    for (const query of this.buildLiveSemanticQueries(seed)) {
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

  private buildExcludedCandidate(
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
    };
  }

  private resolveMergeReadiness(candidate: ClusterCandidate | null): MergeReadiness | null {
    if (!candidate) {
      return null;
    }
    const repo = this.getMeta(META_REPO) ?? "";
    const latestReviewFact = repo ? this.getLatestReviewFact(candidate.prNumber, repo) : null;
    if (candidate.state !== "open") {
      return {
        state: "historical",
        source: "github",
        summary: "Pull request is not open.",
        failingChecks: [],
        pendingChecks: [],
        headSha: candidate.headSha,
        staleReviewFact:
          latestReviewFact && candidate.headSha && latestReviewFact.headSha !== candidate.headSha
            ? {
                headSha: latestReviewFact.headSha,
                decision: latestReviewFact.decision,
                recordedAt: latestReviewFact.recordedAt,
              }
            : undefined,
      };
    }
    if (latestReviewFact && candidate.headSha && latestReviewFact.headSha === candidate.headSha) {
      return {
        state: latestReviewFact.decision,
        source: "review_fact",
        summary: latestReviewFact.summary,
        failingTests: latestReviewFact.failingTests,
        commands: latestReviewFact.commands,
        headSha: latestReviewFact.headSha,
      };
    }
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
    if (!snapshot) {
      return {
        state: "unknown",
        source: "github",
        summary: "No GitHub fact snapshot recorded for this pull request.",
        failingChecks: [],
        pendingChecks: [],
        headSha: candidate.headSha,
      };
    }
    const statusChecks = JSON.parse(
      snapshot.status_rollup_json,
    ) as PullRequestFactRecord["statusChecks"];
    const failingChecks = dedupeCheckNames(
      statusChecks
        .filter((check) => check.conclusion && FAILING_CHECK_CONCLUSIONS.has(check.conclusion))
        .map((check) => check.name),
    );
    const pendingChecks = dedupeCheckNames(
      statusChecks.filter((check) => check.status !== "COMPLETED").map((check) => check.name),
    );
    let state: MergeReadiness["state"] = "ready";
    let summary = "GitHub review decision and checks are green.";
    if (snapshot.review_decision === "CHANGES_REQUESTED") {
      state = "needs_work";
      summary = "GitHub review decision is CHANGES_REQUESTED.";
    } else if (failingChecks.length > 0) {
      state = "needs_work";
      summary = "One or more GitHub checks are failing.";
    } else if (
      snapshot.mergeable === "CONFLICTING" ||
      snapshot.merge_state_status === "DIRTY" ||
      snapshot.merge_state_status === "BLOCKED"
    ) {
      state = "needs_work";
      summary = "GitHub reports the pull request is blocked or conflicting.";
    } else if (pendingChecks.length > 0) {
      state = "pending";
      summary = "GitHub checks are still pending.";
    }
    return {
      state,
      source: "github",
      summary,
      failingChecks,
      pendingChecks,
      headSha: candidate.headSha,
      staleReviewFact:
        latestReviewFact && candidate.headSha && latestReviewFact.headSha !== candidate.headSha
          ? {
              headSha: latestReviewFact.headSha,
              decision: latestReviewFact.decision,
              recordedAt: latestReviewFact.recordedAt,
            }
          : undefined,
    };
  }

  private getLabelsForPr(prNumber: number): string[] {
    const rows = this.db
      .prepare("SELECT label_name FROM pr_labels WHERE pr_number = ? ORDER BY label_name ASC")
      .all(prNumber) as Array<{ label_name: string }>;
    return rows.map((row) => row.label_name);
  }

  private getLabelsForIssue(issueNumber: number): string[] {
    const rows = this.db
      .prepare("SELECT label_name FROM issue_labels WHERE issue_number = ? ORDER BY label_name ASC")
      .all(issueNumber) as Array<{ label_name: string }>;
    return rows.map((row) => row.label_name);
  }

  async show(prNumber: number): Promise<{
    pr: SearchResult | null;
    comments: Array<{
      kind: string;
      author: string;
      createdAt: string;
      url: string;
      excerpt: string;
    }>;
  }> {
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
        const semanticScore = this.computeSemanticScore(seed, candidateRow);
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
          nearbyButExcluded.push(
            this.buildExcludedCandidate(
              candidate,
              "different_linked_issue",
              `different_linked_issue: ${candidate.linkedIssues.map((issue) => `#${issue}`).join(", ")}`,
            ),
          );
          continue;
        }
        if (semanticScore >= 0.35) {
          sameClusterCandidates.push({
            ...candidate,
            reason: "semantic-only candidate",
          });
        } else {
          nearbyButExcluded.push(
            this.buildExcludedCandidate(
              candidate,
              "semantic_weak_match",
              "semantic_weak_match: semantic overlap too weak",
            ),
          );
        }
      }
      return {
        seedPr: {
          prNumber: seed.number,
          title: seed.title,
          url: seed.url,
          state: seed.state,
          updatedAt: seed.updated_at,
        },
        clusterBasis: "semantic_only",
        clusterIssueNumbers: [],
        bestBase: null,
        sameClusterCandidates: sameClusterCandidates
          .sort((left, right) => {
            if ((right.semanticScore ?? 0) !== (left.semanticScore ?? 0)) {
              return (right.semanticScore ?? 0) - (left.semanticScore ?? 0);
            }
            return right.updatedAt.localeCompare(left.updatedAt);
          })
          .slice(0, limit),
        nearbyButExcluded: nearbyButExcluded.slice(0, limit),
        mergeReadiness: null,
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
    const relevantPaths = this.buildRelevantPathSets(params.prNumber, rawCandidates);
    const rankedCandidates = rawCandidates
      .map((candidate) =>
        this.annotateRelevantCoverage(
          candidate,
          relevantPaths.relevantProdFiles,
          relevantPaths.relevantTestFiles,
        ),
      )
      .sort((left, right) => this.rankClusterCandidates(seedLinkedIssues, left, right));

    const bestBase = rankedCandidates[0] ?? null;
    const runnerUp = rankedCandidates[1] ?? null;
    const sameClusterCandidates = rankedCandidates.slice(0, limit).map((candidate, index) => {
      if (!bestBase) {
        return candidate;
      }
      if (index === 0) {
        const reasonCodes = this.buildBestBaseReasonCodes(candidate, runnerUp);
        return {
          ...candidate,
          status: "best_base" as const,
          reasonCodes,
          reason: describeReasonCodes(reasonCodes),
        };
      }
      const reasonCodes = this.buildSupersededReasonCodes(bestBase, candidate);
      if (reasonCodes.length > 0) {
        return {
          ...candidate,
          status: "superseded_candidate" as const,
          supersededBy: bestBase.prNumber,
          reasonCodes,
          reason: describeReasonCodes(reasonCodes),
        };
      }
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
      const annotated = this.annotateRelevantCoverage(
        candidate,
        relevantPaths.relevantProdFiles,
        relevantPaths.relevantTestFiles,
      );
      const otherLinkedIssues = annotated.linkedIssues.filter(
        (issue) => !seedLinkedIssues.includes(issue),
      );
      if (otherLinkedIssues.length > 0) {
        nearbyButExcluded.push(
          this.buildExcludedCandidate(
            annotated,
            "different_linked_issue",
            `different_linked_issue: ${otherLinkedIssues.map((issue) => `#${issue}`).join(", ")}`,
          ),
        );
        continue;
      }
      if (
        annotated.noiseFilesCount >
          annotated.relevantProdFiles.length + annotated.relevantTestFiles.length + 2 &&
        annotated.relevantProdFiles.length + annotated.relevantTestFiles.length <= 1
      ) {
        nearbyButExcluded.push(
          this.buildExcludedCandidate(
            annotated,
            "noise_dominated",
            "noise_dominated: unrelated churn outweighs issue-relevant paths",
          ),
        );
        continue;
      }
      nearbyButExcluded.push(
        this.buildExcludedCandidate(
          annotated,
          "semantic_weak_match",
          "semantic_weak_match: semantic neighbor without exact issue link",
        ),
      );
    }

    return {
      seedPr: {
        prNumber: seed.number,
        title: seed.title,
        url: seed.url,
        state: seed.state,
        updatedAt: seed.updated_at,
      },
      clusterBasis: "linked_issue",
      clusterIssueNumbers: seedLinkedIssues,
      bestBase:
        sameClusterCandidates.find((candidate) => candidate.status === "best_base") ?? bestBase,
      sameClusterCandidates,
      nearbyButExcluded: nearbyButExcluded.slice(0, limit),
      mergeReadiness: this.resolveMergeReadiness(
        sameClusterCandidates.find((candidate) => candidate.status === "best_base") ?? bestBase,
      ),
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
