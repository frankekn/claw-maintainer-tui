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
  HydratedPullRequest,
  IssueDataSource,
  IssueRecord,
  IssueSearchFilters,
  IssueSearchResult,
  ParsedSearchQuery,
  PullRequestDataSource,
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
      await this.initEmbeddingProvider();
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

  private async initEmbeddingProvider(): Promise<void> {
    try {
      this.provider = await createLocalEmbeddingProvider(this.embeddingModel);
    } catch (error) {
      this.provider = null;
      this.vectorError = error instanceof Error ? error.message : String(error);
    }
    this.setMeta(META_EMBEDDING_MODEL, this.embeddingModel);
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
    if (!this.provider || !this.vectorAvailable) {
      return byHash;
    }
    const missing = docs.filter((doc) => !byHash.has(doc.hash));
    if (missing.length === 0) {
      return byHash;
    }
    try {
      const vectors = await this.provider.embedBatch(missing.map((doc) => doc.text));
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

  private upsertHydratedPullRequest(payload: HydratedPullRequest): Promise<void> {
    return (async () => {
      const docs = buildSearchDocuments(payload);
      const docEmbeddings = await this.embedDocuments(docs);
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

          if (this.vectorAvailable && this.vectorDims) {
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
      await this.upsertHydratedPullRequest(payload);
    }

    const tasks = toProcess.map((prNumber) => async () => {
      const hydrated = await params.source.hydratePullRequest(params.repo, prNumber);
      await this.upsertHydratedPullRequest(hydrated);
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
    if (!parsed.text) {
      return this.searchByFiltersOnly(parsed.filters, limit);
    }

    const keywordHits = this.searchKeywordDocs(parsed, limit * 5);
    const vectorHits = await this.searchVectorDocs(parsed, limit * 5);
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
    if (!this.vectorAvailable || !this.vectorDims || !this.provider) {
      return [];
    }
    let queryVec: number[];
    try {
      queryVec = await this.provider.embedQuery(parsed.text);
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
