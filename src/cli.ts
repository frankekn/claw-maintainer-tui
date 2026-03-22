import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { GhCliPullRequestDataSource, parseRepoRef } from "./github.js";
import { isoNow } from "./lib/time.js";
import { ensurePullRequestFacts } from "./pr-facts.js";
import {
  benchmarkSemanticDataset,
  bootstrapSemanticDataset,
  previewNextSemanticReview,
  recordSemanticReview,
} from "./semantic.js";
import { PrIndexStore } from "./store.js";
import { runTui } from "./tui/index.js";
import type {
  PullRequestReviewFact,
  PullRequestShowResult,
  ReviewFactDecision,
  SearchResult,
  SemanticQuerySourceKind,
  SyncSummary,
} from "./types.js";

const COMMAND_USAGE = {
  sync: "sync [--full] [--hydrate-all] [--fts-only] [--repo owner/name] [--db path]",
  "sync-issues": "sync-issues [--full] [--repo owner/name] [--db path]",
  search: "search <query> [--limit N] [--repo owner/name] [--db path]",
  "issue-search": "issue-search <query> [--limit N] [--repo owner/name] [--db path]",
  show: "show <pr-number> [--repo owner/name] [--db path]",
  "issue-show": "issue-show <issue-number> [--repo owner/name] [--db path]",
  status: "status [--repo owner/name] [--db path]",
  tui: "tui [--fts-only] [--repo owner/name] [--db path]",
  "xref-issue": "xref-issue <issue-number> [--limit N] [--repo owner/name] [--db path]",
  "xref-pr": "xref-pr <pr-number> [--limit N] [--repo owner/name] [--db path]",
  "cluster-pr": "cluster-pr <pr-number> [--limit N] [--refresh] [--repo owner/name] [--db path]",
  "review-fact-record":
    "review-fact record --pr <number> --head <sha> --decision ready|needs_work|blocked --summary <text> [--command <cmd>]... [--failing-test <name>]... [--source <name>] [--repo owner/name] [--db path]",
  "review-fact-import":
    "review-fact import <json-file> [--source <name>] [--repo owner/name] [--db path]",
  "semantic-bootstrap":
    "semantic-bootstrap [--repo owner/name] [--db path] [--dataset path] [--limit N] [--seed N] [--source-kind all|title|body|comment]",
  "semantic-review":
    "semantic-review [--repo owner/name] [--db path] [--dataset path] [--split dev|holdout] [--query-id id --primary N --related 12:2,13:1 | --drop]",
  "semantic-benchmark":
    "semantic-benchmark [--repo owner/name] [--db path] [--dataset path] [--split dev|holdout|all] [--limit N] [--fts-only]",
} as const;

type Command = keyof typeof COMMAND_USAGE;

type ParsedArgs = {
  command: Command;
  repo: string;
  full: boolean;
  hydrateAll: boolean;
  ftsOnly: boolean;
  limit: number;
  limitProvided: boolean;
  seed: number;
  split: "dev" | "holdout" | "all";
  sourceKind: "all" | SemanticQuerySourceKind;
  query?: string;
  prNumber?: number;
  dbPath?: string;
  datasetPath?: string;
  queryId?: string;
  primaryPrNumber?: number;
  related?: Array<{ prNumber: number; grade: 1 | 2 }>;
  note?: string;
  drop?: boolean;
  reviewFactPath?: string;
  reviewFactDecision?: ReviewFactDecision;
  reviewFactSummary?: string;
  reviewFactHeadSha?: string;
  reviewFactCommands: string[];
  reviewFactFailingTests: string[];
  reviewFactSource: string;
  refresh: boolean;
};

type CommandContext = {
  args: ParsedArgs;
  repo: ReturnType<typeof parseRepoRef>;
  store: PrIndexStore;
  source: GhCliPullRequestDataSource;
};

type CommandHandler = (context: CommandContext) => Promise<number>;

class CliUsageError extends Error {
  constructor(
    readonly output: string,
    readonly exitCode: number,
    readonly stream: "stdout" | "stderr",
  ) {
    super(output);
  }
}

function usage(): string {
  return [
    "Usage:",
    ...Object.values(COMMAND_USAGE).map((line) => `  clawlens ${line}`),
    "",
    "During development you can still run the same commands via `pnpm clawlens ...`.",
  ].join("\n");
}

function defaultDbPath(repo: string): string {
  const normalized = repo.replace("/", "-");
  return path.join(homedir(), ".cache", "clawlens", "repos", `${normalized}.sqlite`);
}

function defaultDatasetPath(): string {
  return path.resolve("data/semantic");
}

function parseRelated(value: string): Array<{ prNumber: number; grade: 1 | 2 }> {
  if (!value.trim()) {
    return [];
  }
  return value.split(",").map((entry) => {
    const [prNumberRaw, gradeRaw] = entry.split(":");
    const prNumber = Number(prNumberRaw);
    const grade = Number(gradeRaw);
    if (!Number.isInteger(prNumber) || (grade !== 1 && grade !== 2)) {
      throw new Error(`invalid --related entry: ${entry}`);
    }
    return { prNumber, grade: grade as 1 | 2 };
  });
}

function parseCommand(commandRaw: string | undefined, rest: string[]): Command {
  if (!commandRaw) {
    throw new CliUsageError(usage(), 0, "stdout");
  }
  if (commandRaw === "review-fact") {
    const action = rest.shift();
    if (action === "record") {
      return "review-fact-record";
    }
    if (action === "import") {
      return "review-fact-import";
    }
  }
  if (Object.hasOwn(COMMAND_USAGE, commandRaw)) {
    return commandRaw as Command;
  }
  throw new CliUsageError(usage(), 1, "stderr");
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    throw new CliUsageError(usage(), 0, "stdout");
  }

  const [commandRaw, ...restInput] = argv;
  const rest = [...restInput];
  const command = parseCommand(commandRaw, rest);
  const args: ParsedArgs = {
    command,
    repo: "openclaw/openclaw",
    full: false,
    hydrateAll: false,
    ftsOnly: false,
    limit: 20,
    limitProvided: false,
    seed: 1,
    split: "all",
    sourceKind: "all",
    reviewFactCommands: [],
    reviewFactFailingTests: [],
    reviewFactSource: "manual",
    refresh: false,
  };

  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--full") {
      args.full = true;
      continue;
    }
    if (arg === "--hydrate-all") {
      args.hydrateAll = true;
      continue;
    }
    if (arg === "--fts-only") {
      args.ftsOnly = true;
      continue;
    }
    if (arg === "--repo") {
      args.repo = rest[++index] ?? "";
      continue;
    }
    if (arg === "--limit") {
      args.limit = Number(rest[++index] ?? "20");
      args.limitProvided = true;
      continue;
    }
    if (arg === "--pr") {
      args.prNumber = Number(rest[++index] ?? "");
      continue;
    }
    if (arg === "--db") {
      args.dbPath = rest[++index] ?? "";
      continue;
    }
    if (arg === "--dataset") {
      args.datasetPath = rest[++index] ?? "";
      continue;
    }
    if (arg === "--seed") {
      args.seed = Number(rest[++index] ?? "1");
      continue;
    }
    if (arg === "--split") {
      const value = rest[++index] ?? "";
      if (value !== "dev" && value !== "holdout" && value !== "all") {
        throw new Error(`invalid split: ${value}`);
      }
      args.split = value;
      continue;
    }
    if (arg === "--source-kind") {
      const value = rest[++index] ?? "";
      if (value !== "all" && value !== "title" && value !== "body" && value !== "comment") {
        throw new Error(`invalid source kind: ${value}`);
      }
      args.sourceKind = value;
      continue;
    }
    if (arg === "--query-id") {
      args.queryId = rest[++index] ?? "";
      continue;
    }
    if (arg === "--primary") {
      args.primaryPrNumber = Number(rest[++index] ?? "");
      continue;
    }
    if (arg === "--related") {
      args.related = parseRelated(rest[++index] ?? "");
      continue;
    }
    if (arg === "--note") {
      args.note = rest[++index] ?? "";
      continue;
    }
    if (arg === "--head") {
      args.reviewFactHeadSha = rest[++index] ?? "";
      continue;
    }
    if (arg === "--decision") {
      const value = rest[++index] ?? "";
      if (value !== "ready" && value !== "needs_work" && value !== "blocked") {
        throw new Error(`invalid review decision: ${value}`);
      }
      args.reviewFactDecision = value;
      continue;
    }
    if (arg === "--summary") {
      args.reviewFactSummary = rest[++index] ?? "";
      continue;
    }
    if (arg === "--command") {
      args.reviewFactCommands.push(rest[++index] ?? "");
      continue;
    }
    if (arg === "--failing-test") {
      args.reviewFactFailingTests.push(rest[++index] ?? "");
      continue;
    }
    if (arg === "--source") {
      args.reviewFactSource = rest[++index] ?? "";
      continue;
    }
    if (arg === "--refresh") {
      args.refresh = true;
      continue;
    }
    if (arg === "--drop") {
      args.drop = true;
      continue;
    }
    positional.push(arg);
  }

  if (args.command === "search" || args.command === "issue-search") {
    if (positional.length === 0) {
      throw new Error(`${args.command} requires a query`);
    }
    args.query = positional.join(" ");
  }
  if (
    args.command === "show" ||
    args.command === "issue-show" ||
    args.command === "xref-issue" ||
    args.command === "xref-pr" ||
    args.command === "cluster-pr"
  ) {
    if (positional.length !== 1 || Number.isNaN(Number(positional[0]))) {
      throw new Error(`${args.command} requires a numeric identifier`);
    }
    args.prNumber = Number(positional[0]);
  }
  if (args.command === "review-fact-import") {
    if (positional.length !== 1) {
      throw new Error("review-fact import requires a JSON file path");
    }
    args.reviewFactPath = positional[0];
  }
  if (args.command === "review-fact-record") {
    if (!Number.isInteger(args.prNumber)) {
      throw new Error("review-fact record requires --pr <number>");
    }
    if (!args.reviewFactHeadSha) {
      throw new Error("review-fact record requires --head <sha>");
    }
    if (!args.reviewFactDecision) {
      throw new Error("review-fact record requires --decision");
    }
    if (!args.reviewFactSummary) {
      throw new Error("review-fact record requires --summary");
    }
  }
  if (!args.dbPath) {
    args.dbPath = defaultDbPath(args.repo);
  }
  if (!args.datasetPath) {
    args.datasetPath = defaultDatasetPath();
  }
  return args;
}

function formatLabels(labels: string[]): string {
  return labels.length > 0 ? labels.join(", ") : "(none)";
}

function printLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

function normalizeReviewFactRecord(
  value: unknown,
  defaults: { repo: string; source: string },
): PullRequestReviewFact {
  if (!value || typeof value !== "object") {
    throw new Error("review-fact import payload must be an object or array of objects");
  }
  const row = value as Record<string, unknown>;
  const prNumber = Number(row.prNumber ?? row.pr);
  if (!Number.isInteger(prNumber)) {
    throw new Error("review-fact import entry is missing prNumber");
  }
  const headSha = String(row.headSha ?? row.head ?? "").trim();
  const decision = String(row.decision ?? "").trim() as ReviewFactDecision;
  const summary = String(row.summary ?? "").trim();
  if (!headSha || !summary || !["ready", "needs_work", "blocked"].includes(decision)) {
    throw new Error(`review-fact import entry for #${prNumber} is missing required fields`);
  }
  return {
    repo: String(row.repo ?? defaults.repo).trim() || defaults.repo,
    prNumber,
    headSha,
    decision,
    summary,
    commands: Array.isArray(row.commands) ? row.commands.map((item) => String(item)) : [],
    failingTests: (() => {
      const tests = row.failingTests ?? row.failing_tests;
      return Array.isArray(tests) ? tests.map((item) => String(item)) : [];
    })(),
    source: String(row.source ?? defaults.source).trim() || defaults.source,
    recordedAt: typeof row.recordedAt === "string" && row.recordedAt ? row.recordedAt : isoNow(),
  };
}

function printSyncSummary(summary: SyncSummary, options: { includeDocs: boolean }): number {
  printLines([
    `repo: ${summary.repo}`,
    `entity: ${summary.entity}`,
    `mode: ${summary.mode}`,
    `processed_prs: ${summary.processedPrs}`,
    `processed_issues: ${summary.processedIssues}`,
    `skipped_prs: ${summary.skippedPrs}`,
    `skipped_issues: ${summary.skippedIssues}`,
    ...(options.includeDocs
      ? [`docs: ${summary.docCount}`, `comments: ${summary.commentCount}`]
      : []),
    `labels: ${summary.labelCount}`,
    ...(options.includeDocs ? [`vector_available: ${summary.vectorAvailable}`] : []),
    `last_sync_at: ${summary.lastSyncAt}`,
  ]);
  return 0;
}

function printPullRequestShow(payload: PullRequestShowResult): number {
  if (!payload.pr) {
    return 1;
  }
  printLines([
    `#${payload.pr.prNumber} ${payload.pr.title}`,
    `state: ${payload.pr.state}`,
    `author: ${payload.pr.author}`,
    `updated_at: ${payload.pr.updatedAt}`,
    `labels: ${formatLabels(payload.pr.labels)}`,
    `url: ${payload.pr.url}`,
    "",
    payload.pr.matchedExcerpt,
  ]);
  if (payload.comments.length > 0) {
    console.log("");
    console.log("comments:");
    for (const comment of payload.comments) {
      console.log(`- [${comment.kind}] ${comment.author} ${comment.createdAt}`);
      console.log(`  ${comment.excerpt}`);
    }
  }
  return 0;
}

function printSearchResults(results: SearchResult[]): number {
  if (results.length === 0) {
    console.log("No results.");
    return 0;
  }
  for (const result of results) {
    printLines([
      `#${result.prNumber} ${result.title}`,
      `score: ${result.score.toFixed(3)} | state: ${result.state} | author: ${result.author}`,
      `labels: ${formatLabels(result.labels)}`,
      `updated_at: ${result.updatedAt}`,
      `match: ${result.matchedDocKind}`,
      `url: ${result.url}`,
      result.matchedExcerpt,
      "",
    ]);
  }
  return 0;
}

const commandHandlers: Record<Command, CommandHandler> = {
  sync: async ({ args, repo, source, store }) =>
    printSyncSummary(
      await store.sync({
        repo,
        source,
        full: args.full,
        hydrateAll: args.hydrateAll,
      }),
      { includeDocs: true },
    ),

  "sync-issues": async ({ args, repo, source, store }) =>
    printSyncSummary(
      await store.syncIssues({
        repo,
        source,
        full: args.full,
      }),
      { includeDocs: false },
    ),

  status: async ({ args, store }) => {
    const status = await store.status();
    printLines([
      `repo: ${status.repo || args.repo}`,
      `db: ${args.dbPath}`,
      `last_sync_at: ${status.lastSyncAt ?? "(never)"}`,
      `last_sync_watermark: ${status.lastSyncWatermark ?? "(never)"}`,
      `issue_last_sync_at: ${status.issueLastSyncAt ?? "(never)"}`,
      `issue_last_sync_watermark: ${status.issueLastSyncWatermark ?? "(never)"}`,
      `prs: ${status.prCount}`,
      `issues: ${status.issueCount}`,
      `labels: ${status.labelCount}`,
      `issue_labels: ${status.issueLabelCount}`,
      `comments: ${status.commentCount}`,
      `docs: ${status.docCount}`,
      `vector_available: ${status.vectorAvailable}`,
      `vector_error: ${status.vectorError ?? "(none)"}`,
      `embedding_model: ${status.embeddingModel}`,
    ]);
    return 0;
  },

  tui: async ({ args }) => {
    await runTui({
      repo: args.repo,
      dbPath: args.dbPath!,
      ftsOnly: args.ftsOnly,
    });
    return 0;
  },

  "semantic-bootstrap": async ({ args, store }) => {
    const summary = await bootstrapSemanticDataset({
      store,
      datasetPath: args.datasetPath!,
      limit: args.limitProvided ? args.limit : undefined,
      seed: args.seed,
      sourceKinds: args.sourceKind === "all" ? undefined : [args.sourceKind],
    });
    printLines([
      `dataset: ${summary.datasetPath}`,
      `queries: ${summary.queryCount}`,
      `judgments: ${summary.judgmentCount}`,
      `dev_queries: ${summary.splitCounts.dev}`,
      `holdout_queries: ${summary.splitCounts.holdout}`,
    ]);
    return 0;
  },

  "semantic-review": async ({ args, store }) => {
    if (!args.queryId) {
      const preview = await previewNextSemanticReview({
        store,
        datasetPath: args.datasetPath!,
        split: args.split === "all" ? "dev" : args.split,
        limit: args.limit,
      });
      if (!preview) {
        console.log("No pending semantic review queries.");
        return 0;
      }
      printLines([
        `query_id: ${preview.query.queryId}`,
        `split: ${preview.query.split}`,
        `source_kind: ${preview.query.sourceKind}`,
        `source_ref: ${preview.query.sourceRef}`,
        `source_pr: ${preview.query.sourcePrNumber}`,
        `query: ${preview.query.query}`,
      ]);
      if (preview.judgments.length > 0) {
        console.log("draft_judgments:");
        for (const judgment of preview.judgments) {
          console.log(`- pr:${judgment.prNumber} grade:${judgment.grade} ${judgment.rationale}`);
        }
      }
      if (preview.searchPreview.length > 0) {
        console.log("search_preview:");
        for (const result of preview.searchPreview) {
          console.log(`- pr:${result.prNumber} score:${result.score.toFixed(3)} ${result.title}`);
        }
      }
      return 0;
    }

    await recordSemanticReview({
      datasetPath: args.datasetPath!,
      split: args.split === "all" ? "dev" : args.split,
      queryId: args.queryId,
      primaryPrNumber: args.primaryPrNumber,
      related: args.related,
      note: args.note,
      drop: args.drop,
    });
    printLines([`updated_query: ${args.queryId}`, `action: ${args.drop ? "dropped" : "reviewed"}`]);
    return 0;
  },

  "semantic-benchmark": async ({ args, store }) => {
    const report = await benchmarkSemanticDataset({
      store,
      datasetPath: args.datasetPath!,
      split: args.split,
      limit: args.limit,
      mode: args.ftsOnly ? "fts" : "hybrid",
    });
    printLines([
      `split: ${report.split}`,
      `mode: ${report.mode}`,
      `queries: ${report.overall.queryCount}`,
      `mrr: ${report.overall.mrr.toFixed(4)}`,
      `ndcg_at_5: ${report.overall.ndcgAt5.toFixed(4)}`,
      `recall_at_1: ${report.overall.recallAt1.toFixed(4)}`,
      `recall_at_5: ${report.overall.recallAt5.toFixed(4)}`,
      `recall_at_10: ${report.overall.recallAt10.toFixed(4)}`,
    ]);
    for (const [sourceKind, metrics] of Object.entries(report.bySourceKind)) {
      if (!metrics) {
        continue;
      }
      console.log(
        `source:${sourceKind} queries:${metrics.queryCount} mrr:${metrics.mrr.toFixed(4)} ndcg_at_5:${metrics.ndcgAt5.toFixed(4)} recall_at_5:${metrics.recallAt5.toFixed(4)}`,
      );
    }
    return 0;
  },

  show: async ({ args, store }) => {
    const payload = await store.show(args.prNumber!);
    if (!payload.pr) {
      console.log(`PR #${args.prNumber} not found in local index.`);
      return 1;
    }
    return printPullRequestShow(payload);
  },

  "issue-show": async ({ args, store }) => {
    const issue = await store.showIssue(args.prNumber!);
    if (!issue) {
      console.log(`Issue #${args.prNumber} not found in local index.`);
      return 1;
    }
    printLines([
      `#${issue.issueNumber} ${issue.title}`,
      `state: ${issue.state}`,
      `author: ${issue.author}`,
      `updated_at: ${issue.updatedAt}`,
      `labels: ${formatLabels(issue.labels)}`,
      `url: ${issue.url}`,
      "",
      issue.matchedExcerpt,
    ]);
    return 0;
  },

  "xref-issue": async ({ args, store }) => {
    const result = await store.crossReferenceIssueToPullRequests(args.prNumber!, args.limit);
    if (!result.issue) {
      console.log(`Issue #${args.prNumber} not found in local index.`);
      return 1;
    }
    printLines([
      `issue: #${result.issue.issueNumber} ${result.issue.title}`,
      `url: ${result.issue.url}`,
      "",
    ]);
    if (result.pullRequests.length === 0) {
      console.log("No related pull requests found.");
      return 0;
    }
    console.log("related_pull_requests:");
    for (const pr of result.pullRequests) {
      console.log(`- #${pr.prNumber} score:${pr.score.toFixed(3)} ${pr.title}`);
    }
    return 0;
  },

  "xref-pr": async ({ args, store }) => {
    const result = await store.crossReferencePullRequestToIssues(args.prNumber!, args.limit);
    if (!result.pullRequest) {
      console.log(`PR #${args.prNumber} not found in local index.`);
      return 1;
    }
    printLines([
      `pull_request: #${result.pullRequest.prNumber} ${result.pullRequest.title}`,
      `url: ${result.pullRequest.url}`,
      "",
    ]);
    if (result.issues.length === 0) {
      console.log("No related issues found.");
      return 0;
    }
    console.log("related_issues:");
    for (const issue of result.issues) {
      console.log(`- #${issue.issueNumber} score:${issue.score.toFixed(3)} ${issue.title}`);
    }
    return 0;
  },

  "cluster-pr": async ({ args, repo, source, store }) => {
    await ensurePullRequestFacts(store, source, repo, args.prNumber!, args.refresh);
    await store.ensureDerivedIssueLinksBackfilled();
    const refreshed = await store.clusterPullRequest({
      prNumber: args.prNumber!,
      limit: args.limit,
      ftsOnly: true,
      repo,
      source,
      refresh: args.refresh,
    });
    if (!refreshed) {
      console.log(`PR #${args.prNumber} not found in local index.`);
      return 1;
    }
    printLines([
      `seed_pr: #${refreshed.seedPr.prNumber} ${refreshed.seedPr.title}`,
      `url: ${refreshed.seedPr.url}`,
      `cluster_basis: ${refreshed.clusterBasis}`,
      `cluster_issues: ${
        refreshed.clusterIssueNumbers.length > 0
          ? refreshed.clusterIssueNumbers.map((issueNumber) => `#${issueNumber}`).join(", ")
          : "(none)"
      }`,
      "",
    ]);
    if (refreshed.bestBase) {
      printLines([
        `best_base: #${refreshed.bestBase.prNumber} ${refreshed.bestBase.title}`,
        `best_base_reason: ${refreshed.bestBase.reason ?? "highest ranked candidate"}`,
      ]);
    } else {
      console.log("best_base: (none)");
    }
    console.log("");
    console.log("same_cluster_candidates:");
    for (const candidate of refreshed.sameClusterCandidates) {
      const extras = [
        `status:${candidate.status}`,
        `matched_by:${candidate.matchedBy}`,
        `relevant_prod:${candidate.relevantProdFiles.length}/${candidate.prodFiles.length}`,
        `relevant_test:${candidate.relevantTestFiles.length}/${candidate.testFiles.length}`,
        `noise:${candidate.noiseFilesCount}`,
        candidate.supersededBy ? `superseded_by:#${candidate.supersededBy}` : "",
        candidate.reason ? `reason:${candidate.reason}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(`- #${candidate.prNumber} ${candidate.title}`);
      console.log(`  ${extras}`);
    }
    console.log("");
    console.log("nearby_but_excluded:");
    if (refreshed.nearbyButExcluded.length === 0) {
      console.log("- (none)");
    } else {
      for (const candidate of refreshed.nearbyButExcluded) {
        console.log(`- #${candidate.prNumber} ${candidate.title}`);
        console.log(
          `  matched_by:${candidate.matchedBy} reason:${candidate.reason}${
            candidate.semanticScore !== undefined
              ? ` score:${candidate.semanticScore.toFixed(2)}`
              : ""
          }`,
        );
      }
    }
    console.log("");
    if (refreshed.mergeReadiness) {
      printLines([
        `merge_readiness: ${refreshed.mergeReadiness.state}`,
        `merge_readiness_source: ${refreshed.mergeReadiness.source}`,
        `merge_readiness_summary: ${refreshed.mergeReadiness.summary}`,
      ]);
      if (refreshed.mergeReadiness.source === "review_fact") {
        if (refreshed.mergeReadiness.failingTests.length > 0) {
          console.log("failing_tests:");
          for (const failingTest of refreshed.mergeReadiness.failingTests) {
            console.log(`- ${failingTest}`);
          }
        }
      } else {
        if (refreshed.mergeReadiness.failingChecks.length > 0) {
          console.log("failing_checks:");
          for (const failingCheck of refreshed.mergeReadiness.failingChecks) {
            console.log(`- ${failingCheck}`);
          }
        }
        if (refreshed.mergeReadiness.pendingChecks.length > 0) {
          console.log("pending_checks:");
          for (const pendingCheck of refreshed.mergeReadiness.pendingChecks) {
            console.log(`- ${pendingCheck}`);
          }
        }
        if (refreshed.mergeReadiness.staleReviewFact) {
          console.log(
            `stale_review_fact: ${refreshed.mergeReadiness.staleReviewFact.decision} @ ${refreshed.mergeReadiness.staleReviewFact.headSha}`,
          );
        }
      }
    }
    return 0;
  },

  "review-fact-record": async ({ args, store }) => {
    await store.recordReviewFact({
      repo: args.repo,
      prNumber: args.prNumber!,
      headSha: args.reviewFactHeadSha!,
      decision: args.reviewFactDecision!,
      summary: args.reviewFactSummary!,
      commands: args.reviewFactCommands,
      failingTests: args.reviewFactFailingTests,
      source: args.reviewFactSource,
      recordedAt: isoNow(),
    });
    printLines([
      `recorded_review_fact: #${args.prNumber}`,
      `decision: ${args.reviewFactDecision}`,
      `source: ${args.reviewFactSource}`,
    ]);
    return 0;
  },

  "review-fact-import": async ({ args, store }) => {
    const raw = await readFile(args.reviewFactPath!, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    for (const record of records) {
      await store.recordReviewFact(
        normalizeReviewFactRecord(record, {
          repo: args.repo,
          source: args.reviewFactSource,
        }),
      );
    }
    console.log(`imported_review_facts: ${records.length}`);
    return 0;
  },

  "issue-search": async ({ args, store }) => {
    const results = await store.searchIssues(args.query!, args.limit);
    if (results.length === 0) {
      console.log("No results.");
      return 0;
    }
    for (const result of results) {
      printLines([
        `#${result.issueNumber} ${result.title}`,
        `score: ${result.score.toFixed(3)} | state: ${result.state} | author: ${result.author}`,
        `labels: ${formatLabels(result.labels)}`,
        `updated_at: ${result.updatedAt}`,
        `url: ${result.url}`,
        result.matchedExcerpt,
        "",
      ]);
    }
    return 0;
  },

  search: async ({ args, store }) =>
    printSearchResults(await store.search(args.query!, args.limit)),
};

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    const repo = parseRepoRef(args.repo);
    const store = new PrIndexStore({
      dbPath: args.dbPath!,
      enableVector: !args.ftsOnly && args.command !== "cluster-pr",
    });
    const source = new GhCliPullRequestDataSource();
    return await commandHandlers[args.command]({ args, repo, store, source });
  } catch (error) {
    if (error instanceof CliUsageError) {
      if (error.stream === "stdout") {
        console.log(error.output);
      } else {
        console.error(error.output);
      }
      return error.exitCode;
    }
    throw error;
  }
}
