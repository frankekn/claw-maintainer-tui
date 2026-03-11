import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { hashText } from "./lib/internal.js";
import type { PrIndexStore } from "./store.js";
import type {
  SearchDocKind,
  SearchResult,
  SemanticBenchmarkMetrics,
  SemanticBenchmarkReport,
  SemanticBootstrapSummary,
  SemanticCorpusDocument,
  SemanticDatasetManifest,
  SemanticDatasetSplit,
  SemanticJudgmentRecord,
  SemanticQueryRecord,
  SemanticQuerySourceKind,
  SemanticReviewDecisionRecord,
  SemanticReviewPreview,
  SemanticRelevanceGrade,
} from "./types.js";

const DATASET_SCHEMA_VERSION = 1;
const DEFAULT_RELATED_LIMIT = 3;
const HOLDOUT_MODULUS = 5;
const HOLDOUT_BUCKET = 0;
const QUERY_MIN_LENGTH = 18;
const SENTENCE_MAX_LENGTH = 220;
const SENTENCE_HINT_RE =
  /\b(repro|regression|break|broken|fails?|failing|crash|bypass|error|cannot|can't|stuck|timeout|sanitize|spoof|missing|ignore)\b/i;
const BOILERPLATE_RE =
  /\b(thanks|thank you|changelog|follow[- ]up|duplicate of|fixes #|closes #|see also|https?:\/\/)\b/i;
const META_SENTENCE_RE =
  /\b(what did not change|scope boundary|why it matters|mitigation|document new|replaces #|left unresolved|reviewer|maintainer judgment|tracking issue|config example|checklist|active maintenance signal|what you personally verified|resubmitted after|auto-close|queue-cap|manual auth additions)\b/i;
const MARKDOWN_ARTIFACT_RE = /[`*_#\[\]]|^\s*[-*]\s+|^\s*\[[ x]\]\s+/i;
const CODE_HEAVY_RE =
  /\b(?:src|docs|test|packages|scripts|extensions)\/[^\s]+|(?:[A-Za-z0-9_.-]+\/){2,}[A-Za-z0-9_.-]+\b/;
const TITLE_PREFIX_RE = /^(fix|feat|refactor|docs|test|build|ci|perf|chore)(\([\w/-]+\))?:\s*/i;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "up",
  "with",
]);

type QueryCandidate = {
  query: string;
  sourceKind: SemanticQuerySourceKind;
  sourceRef: string;
  sourcePrNumber: number;
  clusterKey: string;
  score: number;
  notes?: string;
};

type DatasetBundle = {
  manifest: SemanticDatasetManifest;
  queries: SemanticQueryRecord[];
  judgments: SemanticJudgmentRecord[];
  decisions: SemanticReviewDecisionRecord[];
};

type EffectiveQuery = {
  query: SemanticQueryRecord;
  judgments: SemanticJudgmentRecord[];
  decision?: SemanticReviewDecisionRecord;
};

function defaultManifest(repo: string, timestamp: string): SemanticDatasetManifest {
  return {
    schemaVersion: DATASET_SCHEMA_VERSION,
    repo,
    createdAt: timestamp,
    updatedAt: timestamp,
    splits: {
      dev: { queries: 0, judgments: 0, decisions: 0 },
      holdout: { queries: 0, judgments: 0, decisions: 0 },
    },
  };
}

function splitFile(outDir: string, prefix: string, split: SemanticDatasetSplit): string {
  return path.join(outDir, `${prefix}.${split}.jsonl`);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseJsonLines<T>(content: string): T[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function readJsonLinesFile<T>(filePath: string): Promise<T[]> {
  try {
    return parseJsonLines<T>(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeJsonLinesFile<T>(filePath: string, records: T[]): Promise<void> {
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(filePath, body ? `${body}\n` : "", "utf8");
}

async function appendJsonLine<T>(filePath: string, record: T): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function stableBucket(key: string, seed: number): number {
  const digest = hashText(`${seed}:${key}`);
  return parseInt(digest.slice(0, 8), 16);
}

function splitForCluster(clusterKey: string, seed: number): SemanticDatasetSplit {
  return stableBucket(clusterKey, seed) % HOLDOUT_MODULUS === HOLDOUT_BUCKET ? "holdout" : "dev";
}

function normalizeTitle(title: string): string {
  return normalizeWhitespace(title.replace(TITLE_PREFIX_RE, "").replace(/[#()[\]_/:-]+/g, " "));
}

function tokenize(value: string): string[] {
  return normalizeWhitespace(value.toLowerCase())
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function buildClusterKey(title: string): string {
  const tokens = Array.from(new Set(tokenize(normalizeTitle(title))));
  return tokens.slice(0, 4).join("-");
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/[\n.!?]+/g)
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean);
}

function sanitizeQueryText(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/^\s*[-*]\s+/, "")
      .replace(/^\s*\[[ x]\]\s+/, "")
      .replace(/^repro:\s*/i, "")
      .replace(/^issue:\s*/i, "")
      .replace(/^problem:\s*/i, "")
      .replace(/^symptom:\s*/i, ""),
  );
}

function scoreSentence(sentence: string, titleTokens: Set<string>, preferHint: boolean): number {
  if (sentence.length < QUERY_MIN_LENGTH || sentence.length > SENTENCE_MAX_LENGTH) {
    return -1;
  }
  if (BOILERPLATE_RE.test(sentence) || META_SENTENCE_RE.test(sentence)) {
    return -1;
  }
  if (MARKDOWN_ARTIFACT_RE.test(sentence)) {
    return -1;
  }
  if (CODE_HEAVY_RE.test(sentence)) {
    return -1;
  }
  const tokens = tokenize(sentence);
  if (tokens.length < 4) {
    return -1;
  }
  const novelTokens = tokens.filter((token) => !titleTokens.has(token)).length;
  const hintBonus = preferHint && SENTENCE_HINT_RE.test(sentence) ? 8 : 0;
  return novelTokens * 2 + hintBonus - Math.max(0, sentence.length - 120) / 60;
}

function deriveCandidateQueries(doc: SemanticCorpusDocument): QueryCandidate[] {
  const clusterKey = buildClusterKey(doc.title);
  if (!clusterKey) {
    return [];
  }
  const title = sanitizeQueryText(normalizeTitle(doc.title));
  const titleTokens = new Set(tokenize(title));
  const candidates: QueryCandidate[] = [];
  if (title.length >= QUERY_MIN_LENGTH) {
    candidates.push({
      query: title,
      sourceKind: "title",
      sourceRef: doc.docId,
      sourcePrNumber: doc.prNumber,
      clusterKey,
      score: 8,
      notes: "title-derived bootstrap query",
    });
  }

  const sentences = splitSentences(doc.text);
  let bestSentence = "";
  let bestScore = -1;
  for (const sentence of sentences) {
    const score = scoreSentence(sentence, titleTokens, doc.docKind === "comment");
    if (score > bestScore) {
      bestScore = score;
      bestSentence = sentence;
    }
  }
  if (bestSentence) {
    const query = sanitizeQueryText(bestSentence);
    candidates.push({
      query,
      sourceKind: doc.docKind === "comment" ? "comment" : "body",
      sourceRef: doc.docId,
      sourcePrNumber: doc.prNumber,
      clusterKey,
      score: bestScore + (doc.docKind === "comment" ? 10 : 5),
      notes: `${doc.docKind}-derived bootstrap query`,
    });
  }
  return candidates;
}

function normalizeQueryKey(query: string, clusterKey: string): string {
  return `${clusterKey}:${sanitizeQueryText(query).toLowerCase()}`;
}

function gradeRelatedCandidate(
  primaryClusterKey: string,
  primary: SearchResult,
  related: SearchResult,
): SemanticRelevanceGrade | null {
  if (buildClusterKey(related.title) === primaryClusterKey) {
    return 2;
  }
  if (related.score >= Math.max(0.35, primary.score * 0.55)) {
    return 1;
  }
  return null;
}

function gradeGain(grade: SemanticRelevanceGrade): number {
  return 2 ** grade - 1;
}

function toMetrics(
  queryCount: number,
  mrr: number,
  ndcgAt5: number,
  recallAt1: number,
  recallAt5: number,
  recallAt10: number,
): SemanticBenchmarkMetrics {
  if (queryCount === 0) {
    return {
      mrr: 0,
      ndcgAt5: 0,
      recallAt1: 0,
      recallAt5: 0,
      recallAt10: 0,
      queryCount: 0,
    };
  }
  return {
    mrr: mrr / queryCount,
    ndcgAt5: ndcgAt5 / queryCount,
    recallAt1: recallAt1 / queryCount,
    recallAt5: recallAt5 / queryCount,
    recallAt10: recallAt10 / queryCount,
    queryCount,
  };
}

function resolveLatestDecisions(
  decisions: SemanticReviewDecisionRecord[],
): Map<string, SemanticReviewDecisionRecord> {
  const byQuery = new Map<string, SemanticReviewDecisionRecord>();
  for (const decision of decisions) {
    byQuery.set(decision.queryId, decision);
  }
  return byQuery;
}

function resolveEffectiveQueries(bundle: DatasetBundle): EffectiveQuery[] {
  const latestDecisions = resolveLatestDecisions(bundle.decisions);
  const judgmentsByQuery = new Map<string, SemanticJudgmentRecord[]>();
  for (const judgment of bundle.judgments) {
    const list = judgmentsByQuery.get(judgment.queryId) ?? [];
    list.push(judgment);
    judgmentsByQuery.set(judgment.queryId, list);
  }

  const resolved: EffectiveQuery[] = [];
  for (const query of bundle.queries) {
    const decision = latestDecisions.get(query.queryId);
    if (decision?.action === "dropped") {
      continue;
    }
    const rawJudgments = judgmentsByQuery.get(query.queryId) ?? [];
    const reviewJudgments = rawJudgments.filter((judgment) => judgment.labelSource === "review");
    const effectiveJudgments = reviewJudgments.length > 0 ? reviewJudgments : rawJudgments;
    if (effectiveJudgments.length === 0) {
      continue;
    }
    resolved.push({
      query,
      judgments: effectiveJudgments,
      decision,
    });
  }
  return resolved;
}

function validateEffectiveJudgments(
  query: SemanticQueryRecord,
  judgments: SemanticJudgmentRecord[],
): void {
  const primaryCount = judgments.filter((judgment) => judgment.grade === 3).length;
  if (primaryCount !== 1) {
    throw new Error(`query ${query.queryId} must resolve to exactly one primary judgment`);
  }
}

async function loadDataset(
  datasetPath: string,
  split: SemanticDatasetSplit | "all",
): Promise<DatasetBundle> {
  const manifest = JSON.parse(
    await readFile(path.join(datasetPath, "manifest.json"), "utf8"),
  ) as SemanticDatasetManifest;
  const splits: SemanticDatasetSplit[] = split === "all" ? ["dev", "holdout"] : [split];
  const queries = (
    await Promise.all(
      splits.map((value) =>
        readJsonLinesFile<SemanticQueryRecord>(splitFile(datasetPath, "queries", value)),
      ),
    )
  ).flat();
  const judgments = (
    await Promise.all(
      splits.map((value) =>
        readJsonLinesFile<SemanticJudgmentRecord>(splitFile(datasetPath, "judgments", value)),
      ),
    )
  ).flat();
  const decisions = (
    await Promise.all(
      splits.map((value) =>
        readJsonLinesFile<SemanticReviewDecisionRecord>(splitFile(datasetPath, "decisions", value)),
      ),
    )
  ).flat();
  return { manifest, queries, judgments, decisions };
}

async function writeDataset(
  datasetPath: string,
  repo: string,
  queries: SemanticQueryRecord[],
  judgments: SemanticJudgmentRecord[],
): Promise<void> {
  const timestamp = new Date().toISOString();
  const manifest = defaultManifest(repo, timestamp);
  await mkdir(datasetPath, { recursive: true });
  for (const split of ["dev", "holdout"] as const) {
    const splitQueries = queries.filter((query) => query.split === split);
    const splitJudgments = judgments.filter((judgment) =>
      splitQueries.some((query) => query.queryId === judgment.queryId),
    );
    await writeJsonLinesFile(splitFile(datasetPath, "queries", split), splitQueries);
    await writeJsonLinesFile(splitFile(datasetPath, "judgments", split), splitJudgments);
    await writeJsonLinesFile(splitFile(datasetPath, "decisions", split), []);
    manifest.splits[split] = {
      queries: splitQueries.length,
      judgments: splitJudgments.length,
      decisions: 0,
    };
  }
  await writeFile(
    path.join(datasetPath, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function refreshManifest(
  datasetPath: string,
  repo?: string,
): Promise<SemanticDatasetManifest> {
  const manifestPath = path.join(datasetPath, "manifest.json");
  let manifest: SemanticDatasetManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SemanticDatasetManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const timestamp = new Date().toISOString();
    manifest = defaultManifest(repo ?? "", timestamp);
  }

  const now = new Date().toISOString();
  for (const split of ["dev", "holdout"] as const) {
    manifest.splits[split] = {
      queries: (
        await readJsonLinesFile<SemanticQueryRecord>(splitFile(datasetPath, "queries", split))
      ).length,
      judgments: (
        await readJsonLinesFile<SemanticJudgmentRecord>(splitFile(datasetPath, "judgments", split))
      ).length,
      decisions: (
        await readJsonLinesFile<SemanticReviewDecisionRecord>(
          splitFile(datasetPath, "decisions", split),
        )
      ).length,
    };
  }
  manifest.updatedAt = now;
  if (!manifest.createdAt) {
    manifest.createdAt = now;
  }
  if (repo) {
    manifest.repo = repo;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function bootstrapSemanticDataset(params: {
  store: PrIndexStore;
  datasetPath: string;
  seed?: number;
  limit?: number;
  relatedLimit?: number;
  sourceKinds?: SemanticQuerySourceKind[];
}): Promise<SemanticBootstrapSummary> {
  const seed = params.seed ?? 1;
  const limit = params.limit ?? 0;
  const relatedLimit = params.relatedLimit ?? DEFAULT_RELATED_LIMIT;
  const allowedSourceKinds = new Set<SemanticQuerySourceKind>(
    params.sourceKinds ?? ["title", "body", "comment"],
  );
  const corpus = await params.store.listSemanticCorpusDocuments();
  const status = await params.store.status();
  const docsByPr = new Map<number, SemanticCorpusDocument[]>();
  for (const doc of corpus) {
    const list = docsByPr.get(doc.prNumber) ?? [];
    list.push(doc);
    docsByPr.set(doc.prNumber, list);
  }

  const seenQueries = new Set<string>();
  const queryRecords: SemanticQueryRecord[] = [];
  const judgments: SemanticJudgmentRecord[] = [];

  for (const [prNumber, docs] of docsByPr.entries()) {
    const best = docs
      .flatMap((doc) => deriveCandidateQueries(doc))
      .filter((candidate) => allowedSourceKinds.has(candidate.sourceKind))
      .sort((a, b) => b.score - a.score)[0];
    if (!best) {
      continue;
    }
    const queryKey = normalizeQueryKey(best.query, best.clusterKey);
    if (seenQueries.has(queryKey)) {
      continue;
    }
    seenQueries.add(queryKey);
    const split = splitForCluster(best.clusterKey, seed);
    const queryId = `q:${prNumber}`;
    const queryRecord: SemanticQueryRecord = {
      queryId,
      query: best.query,
      split,
      sourceKind: best.sourceKind,
      sourceRef: best.sourceRef,
      sourcePrNumber: best.sourcePrNumber,
      clusterKey: best.clusterKey,
      notes: best.notes,
    };
    queryRecords.push(queryRecord);
    judgments.push({
      queryId,
      prNumber,
      grade: 3,
      rationale: `bootstrap primary from ${best.sourceKind}`,
      evidenceDocKind: best.sourceKind === "comment" ? "comment" : "pr_body",
      evidenceRef: best.sourceRef,
      labelSource: "bootstrap",
    });

    const results = await params.store.search(best.query, relatedLimit + 5);
    const primary = results.find((result) => result.prNumber === prNumber) ?? {
      prNumber,
      title: docs[0]?.title ?? "",
      url: "",
      state: docs[0]?.state ?? "open",
      author: docs[0]?.author ?? "",
      labels: docs[0]?.labels ?? [],
      updatedAt: docs[0]?.updatedAt ?? "",
      score: 1,
      matchedDocKind: best.sourceKind === "comment" ? "comment" : "pr_body",
      matchedExcerpt: best.query,
    };
    const relatedSeen = new Set<number>([prNumber]);
    for (const result of results) {
      if (relatedSeen.has(result.prNumber)) {
        continue;
      }
      const grade = gradeRelatedCandidate(best.clusterKey, primary, result);
      if (!grade) {
        continue;
      }
      judgments.push({
        queryId,
        prNumber: result.prNumber,
        grade,
        rationale:
          grade === 2 ? "bootstrap same-title cluster candidate" : "bootstrap retrieval candidate",
        evidenceDocKind: result.matchedDocKind as SearchDocKind,
        evidenceRef: `pr:${result.prNumber}`,
        labelSource: "bootstrap",
      });
      relatedSeen.add(result.prNumber);
      if (relatedSeen.size - 1 >= relatedLimit) {
        break;
      }
    }

    if (limit > 0 && queryRecords.length >= limit) {
      break;
    }
  }

  await writeDataset(params.datasetPath, status.repo, queryRecords, judgments);
  return {
    datasetPath: params.datasetPath,
    queryCount: queryRecords.length,
    judgmentCount: judgments.length,
    splitCounts: {
      dev: queryRecords.filter((query) => query.split === "dev").length,
      holdout: queryRecords.filter((query) => query.split === "holdout").length,
    },
  };
}

export async function previewNextSemanticReview(params: {
  store: PrIndexStore;
  datasetPath: string;
  split: SemanticDatasetSplit;
  limit?: number;
}): Promise<SemanticReviewPreview | null> {
  const bundle = await loadDataset(params.datasetPath, params.split);
  const latestDecisions = resolveLatestDecisions(bundle.decisions);
  const nextQuery = bundle.queries.find((query) => !latestDecisions.has(query.queryId));
  if (!nextQuery) {
    return null;
  }
  const draftJudgments = bundle.judgments.filter(
    (judgment) => judgment.queryId === nextQuery.queryId,
  );
  return {
    query: nextQuery,
    judgments: draftJudgments,
    searchPreview: await params.store.search(nextQuery.query, params.limit ?? 10),
  };
}

export async function recordSemanticReview(params: {
  datasetPath: string;
  split: SemanticDatasetSplit;
  queryId: string;
  primaryPrNumber?: number;
  related?: Array<{ prNumber: number; grade: 1 | 2 }>;
  note?: string;
  drop?: boolean;
}): Promise<void> {
  const bundle = await loadDataset(params.datasetPath, params.split);
  const query = bundle.queries.find((item) => item.queryId === params.queryId);
  if (!query) {
    throw new Error(`query ${params.queryId} not found in ${params.split}`);
  }
  const decisionsPath = splitFile(params.datasetPath, "decisions", params.split);
  const judgmentsPath = splitFile(params.datasetPath, "judgments", params.split);
  if (params.drop) {
    await appendJsonLine(decisionsPath, {
      queryId: params.queryId,
      action: "dropped",
      decidedAt: new Date().toISOString(),
      note: params.note,
    } satisfies SemanticReviewDecisionRecord);
    await refreshManifest(params.datasetPath);
    return;
  }
  if (!params.primaryPrNumber) {
    throw new Error("primary PR number is required unless --drop is set");
  }

  const related = params.related ?? [];
  const seen = new Set<number>();
  const reviewJudgments: SemanticJudgmentRecord[] = [];
  for (const entry of [{ prNumber: params.primaryPrNumber, grade: 3 as const }, ...related]) {
    if (seen.has(entry.prNumber)) {
      throw new Error(`duplicate PR ${entry.prNumber} in review payload`);
    }
    seen.add(entry.prNumber);
    reviewJudgments.push({
      queryId: params.queryId,
      prNumber: entry.prNumber,
      grade: entry.grade,
      rationale: entry.grade === 3 ? "reviewed primary target" : "reviewed related target",
      evidenceDocKind: query.sourceKind === "comment" ? "comment" : "pr_body",
      evidenceRef: query.sourceRef,
      labelSource: "review",
    });
  }
  validateEffectiveJudgments(query, reviewJudgments);
  for (const judgment of reviewJudgments) {
    await appendJsonLine(judgmentsPath, judgment);
  }
  await appendJsonLine(decisionsPath, {
    queryId: params.queryId,
    action: "reviewed",
    decidedAt: new Date().toISOString(),
    note: params.note,
  } satisfies SemanticReviewDecisionRecord);
  await refreshManifest(params.datasetPath);
}

export async function benchmarkSemanticDataset(params: {
  store: PrIndexStore;
  datasetPath: string;
  split: SemanticDatasetSplit | "all";
  limit?: number;
  mode: "fts" | "hybrid";
}): Promise<SemanticBenchmarkReport> {
  const bundle = await loadDataset(params.datasetPath, params.split);
  const effective = resolveEffectiveQueries(bundle);
  const overallAccumulator = {
    mrr: 0,
    ndcgAt5: 0,
    recallAt1: 0,
    recallAt5: 0,
    recallAt10: 0,
    queryCount: 0,
  };
  const bySource = new Map<
    SemanticQuerySourceKind,
    {
      mrr: number;
      ndcgAt5: number;
      recallAt1: number;
      recallAt5: number;
      recallAt10: number;
      queryCount: number;
    }
  >();

  for (const item of effective) {
    validateEffectiveJudgments(item.query, item.judgments);
    const results = await params.store.search(item.query.query, params.limit ?? 10);
    const gradeByPr = new Map(
      item.judgments.map((judgment) => [judgment.prNumber, judgment.grade]),
    );
    const totalRelevant = item.judgments.length;
    const primaryPrNumber = item.judgments.find((judgment) => judgment.grade === 3)?.prNumber ?? -1;

    const relevantAt = (k: number): number => {
      const count = results
        .slice(0, k)
        .filter((result) => (gradeByPr.get(result.prNumber) ?? 0) > 0).length;
      return totalRelevant === 0 ? 0 : count / totalRelevant;
    };

    let reciprocalRank = 0;
    for (let index = 0; index < results.length; index += 1) {
      if (results[index]?.prNumber === primaryPrNumber) {
        reciprocalRank = 1 / (index + 1);
        break;
      }
    }

    const dcg = results.slice(0, 5).reduce((sum, result, index) => {
      const grade = gradeByPr.get(result.prNumber);
      if (!grade) {
        return sum;
      }
      return sum + gradeGain(grade) / Math.log2(index + 2);
    }, 0);
    const ideal = item.judgments
      .map((judgment) => judgment.grade)
      .sort((a, b) => b - a)
      .slice(0, 5)
      .reduce((sum, grade, index) => sum + gradeGain(grade) / Math.log2(index + 2), 0);
    const ndcgAt5 = ideal > 0 ? dcg / ideal : 0;

    overallAccumulator.mrr += reciprocalRank;
    overallAccumulator.ndcgAt5 += ndcgAt5;
    overallAccumulator.recallAt1 += relevantAt(1);
    overallAccumulator.recallAt5 += relevantAt(5);
    overallAccumulator.recallAt10 += relevantAt(10);
    overallAccumulator.queryCount += 1;

    const bucket = bySource.get(item.query.sourceKind) ?? {
      mrr: 0,
      ndcgAt5: 0,
      recallAt1: 0,
      recallAt5: 0,
      recallAt10: 0,
      queryCount: 0,
    };
    bucket.mrr += reciprocalRank;
    bucket.ndcgAt5 += ndcgAt5;
    bucket.recallAt1 += relevantAt(1);
    bucket.recallAt5 += relevantAt(5);
    bucket.recallAt10 += relevantAt(10);
    bucket.queryCount += 1;
    bySource.set(item.query.sourceKind, bucket);
  }

  return {
    split: params.split,
    mode: params.mode,
    overall: toMetrics(
      overallAccumulator.queryCount,
      overallAccumulator.mrr,
      overallAccumulator.ndcgAt5,
      overallAccumulator.recallAt1,
      overallAccumulator.recallAt5,
      overallAccumulator.recallAt10,
    ),
    bySourceKind: Object.fromEntries(
      Array.from(bySource.entries()).map(([sourceKind, values]) => [
        sourceKind,
        toMetrics(
          values.queryCount,
          values.mrr,
          values.ndcgAt5,
          values.recallAt1,
          values.recallAt5,
          values.recallAt10,
        ),
      ]),
    ),
  };
}
