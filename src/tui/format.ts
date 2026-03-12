import type {
  ClusterCandidate,
  ClusterExcludedCandidate,
  IssueSearchResult,
  SearchResult,
  StatusSnapshot,
} from "../types.js";
import { TUI_MODE_ORDER } from "./types.js";
import type { TuiFocus, TuiHeaderModel, TuiRenderModel, TuiResultRow } from "./types.js";

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "never";
  }
  return value.replace("T", " ").replace(".000Z", "Z");
}

export function formatRelativeAge(value: string | null, now = new Date()): string {
  if (!value) {
    return "never";
  }
  const then = new Date(value);
  const diffMs = Math.max(0, now.getTime() - then.getTime());
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, limit: number): string {
  const trimmed = cleanText(value);
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function section(title: string): string {
  return title.toUpperCase();
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function formatState(value: string): string {
  return padRight(value.toUpperCase(), 6);
}

function formatPrRow(result: SearchResult): string {
  return `#${String(result.prNumber).padEnd(6)} ${formatState(result.state)} ${result.score
    .toFixed(3)
    .padStart(5)}  ${truncate(result.title, 64)}`;
}

function formatIssueRow(result: IssueSearchResult): string {
  return `#${String(result.issueNumber).padEnd(6)} ${formatState(result.state)} ${result.score
    .toFixed(3)
    .padStart(5)}  ${truncate(result.title, 64)}`;
}

function formatClusterCandidateRow(candidate: ClusterCandidate): string {
  const coverage = [
    padRight(candidate.status.toUpperCase(), 9),
    padRight(candidate.matchedBy, 12),
    `p${candidate.relevantProdFiles.length}/${candidate.prodFiles.length}`,
    `t${candidate.relevantTestFiles.length}/${candidate.testFiles.length}`,
    `n${candidate.noiseFilesCount}`,
  ];
  return `#${String(candidate.prNumber).padEnd(6)} ${coverage.join(" ")} ${truncate(candidate.title, 40)}`;
}

function formatClusterExcludedRow(candidate: ClusterExcludedCandidate): string {
  const scoreSuffix =
    candidate.semanticScore !== undefined ? ` score:${candidate.semanticScore.toFixed(2)}` : "";
  return `#${String(candidate.prNumber).padEnd(6)} EXCLUDED ${padRight(
    candidate.excludedReasonCode,
    14,
  )} ${truncate(candidate.title, 42)}${scoreSuffix}`;
}

export function formatResultRow(row: TuiResultRow): string {
  switch (row.kind) {
    case "pr":
      return formatPrRow(row.pr);
    case "issue":
      return formatIssueRow(row.issue);
    case "cluster-candidate":
      return formatClusterCandidateRow(row.candidate);
    case "cluster-excluded":
      return formatClusterExcludedRow(row.candidate);
    case "status":
      return `${row.label}: ${row.value}`;
    default:
      return "";
  }
}

function formatLabelBlock(labels: string[]): string {
  return labels.length > 0 ? labels.join(", ") : "(none)";
}

export function formatPrDetail(
  pr: SearchResult,
  comments: Array<{ kind: string; author: string; createdAt: string; excerpt: string }>,
): string {
  const lines = [
    `PR #${pr.prNumber} ${pr.title}`,
    `${formatState(pr.state).trim()}  ${pr.author}  ${pr.updatedAt}`,
    `labels  ${formatLabelBlock(pr.labels)}`,
    `github  ${pr.url}`,
    "",
    section("Summary"),
    truncate(pr.matchedExcerpt, 560),
  ];
  if (comments.length > 0) {
    lines.push("", `${section("Comments")} (${comments.length})`);
    for (const comment of comments) {
      lines.push(`- [${comment.kind}] ${comment.author} ${comment.createdAt}`);
      lines.push(`  ${truncate(comment.excerpt, 200)}`);
    }
  }
  return lines.join("\n");
}

export function formatIssueDetail(issue: IssueSearchResult): string {
  return [
    `Issue #${issue.issueNumber} ${issue.title}`,
    `${formatState(issue.state).trim()}  ${issue.author}  ${issue.updatedAt}`,
    `labels  ${formatLabelBlock(issue.labels)}`,
    `github  ${issue.url}`,
    "",
    section("Summary"),
    truncate(issue.matchedExcerpt, 560),
  ].join("\n");
}

export function formatClusterDetail(
  analysis: {
    seedLabel: string;
    clusterBasis: string;
    clusterIssues: number[];
    mergeSummary: string | null;
  },
  candidate: ClusterCandidate | ClusterExcludedCandidate,
): string {
  const lines = [
    section("Seed"),
    analysis.seedLabel,
    "",
    section("Cluster"),
    `cluster_basis: ${analysis.clusterBasis}`,
    `cluster_issues: ${
      analysis.clusterIssues.length > 0
        ? analysis.clusterIssues.map((issue) => `#${issue}`).join(", ")
        : "(none)"
    }`,
  ];
  if (analysis.mergeSummary) {
    lines.push(`merge_readiness: ${analysis.mergeSummary}`);
  }
  lines.push("");
  if ("excludedReasonCode" in candidate) {
    lines.push(section("Excluded Candidate"));
    lines.push(`excluded_candidate: #${candidate.prNumber} ${candidate.title}`);
    lines.push(`matched_by: ${candidate.matchedBy}`);
    lines.push(`reason: ${candidate.reason}`);
    lines.push(
      `linked_issues: ${candidate.linkedIssues.map((issue) => `#${issue}`).join(", ") || "(none)"}`,
    );
    if (candidate.semanticScore !== undefined) {
      lines.push(`semantic_score: ${candidate.semanticScore.toFixed(2)}`);
    }
  } else {
    lines.push(section("Candidate"));
    lines.push(`candidate: #${candidate.prNumber} ${candidate.title}`);
    lines.push(`status: ${candidate.status}`);
    lines.push(`matched_by: ${candidate.matchedBy}`);
    lines.push(
      `relevant_prod: ${candidate.relevantProdFiles.length}/${candidate.prodFiles.length}`,
    );
    lines.push(
      `relevant_test: ${candidate.relevantTestFiles.length}/${candidate.testFiles.length}`,
    );
    lines.push(`noise: ${candidate.noiseFilesCount}`);
    lines.push(
      `linked_issues: ${candidate.linkedIssues.map((issue) => `#${issue}`).join(", ") || "(none)"}`,
    );
    if (candidate.supersededBy) {
      lines.push(`superseded_by: #${candidate.supersededBy}`);
    }
    if (candidate.reason) {
      lines.push(`reason: ${candidate.reason}`);
    }
  }
  return lines.join("\n");
}

export function formatStatusDetail(status: StatusSnapshot, now = new Date()): string {
  return [
    section("Index Status"),
    `repo: ${status.repo}`,
    `last_sync_at: ${formatTimestamp(status.lastSyncAt)}`,
    `last_sync_age: ${formatRelativeAge(status.lastSyncAt, now)}`,
    `issue_last_sync_at: ${formatTimestamp(status.issueLastSyncAt)}`,
    `issue_last_sync_age: ${formatRelativeAge(status.issueLastSyncAt, now)}`,
    "",
    section("Counts"),
    `prs: ${status.prCount}`,
    `issues: ${status.issueCount}`,
    `labels: ${status.labelCount}`,
    `issue_labels: ${status.issueLabelCount}`,
    `comments: ${status.commentCount}`,
    `docs: ${status.docCount}`,
    "",
    section("Vector"),
    `vector_available: ${status.vectorAvailable}`,
    `vector_error: ${status.vectorError ?? "(none)"}`,
    `embedding_model: ${status.embeddingModel}`,
    "",
    section("Tips"),
    "Press / to filter the active list.",
    "Use x for cross-reference and c for cluster analysis.",
  ].join("\n");
}

export function formatSearchLandingDetail(
  mode: "pr-search" | "issue-search",
  status: StatusSnapshot | null,
  now = new Date(),
): string {
  const noun = mode === "pr-search" ? "PR" : "issue";
  const plural = mode === "pr-search" ? "PRs" : "issues";
  const count = status ? (mode === "pr-search" ? status.prCount : status.issueCount) : null;
  const lines = [section("Desk Brief"), `Active list: recent open ${plural}`];
  if (status) {
    lines.push(`Repo: ${status.repo}`);
    lines.push(`Local rows: ${count}`);
    lines.push(
      `Freshness: PR ${formatRelativeAge(status.lastSyncAt, now)}  Issue ${formatRelativeAge(status.issueLastSyncAt, now)}`,
    );
    lines.push(
      `Vector: ${status.vectorAvailable ? "ready" : (status.vectorError ?? "unavailable")}`,
    );
  }
  lines.push(
    "",
    section("Next"),
    `Press / to refine the ${noun} list without leaving this view.`,
    "Press Enter to inspect the selected row.",
    mode === "pr-search"
      ? "Press x to jump into linked issues and c to inspect cluster neighbors."
      : "Press x to jump into linked pull requests.",
    "Press o to open the selected GitHub page in the browser.",
  );
  return lines.join("\n");
}

export function buildStatusRows(status: StatusSnapshot): TuiResultRow[] {
  return [
    { kind: "status", label: "PRs", value: String(status.prCount) },
    { kind: "status", label: "Issues", value: String(status.issueCount) },
    { kind: "status", label: "PR Labels", value: String(status.labelCount) },
    { kind: "status", label: "Issue Labels", value: String(status.issueLabelCount) },
    { kind: "status", label: "Comments", value: String(status.commentCount) },
    { kind: "status", label: "Docs", value: String(status.docCount) },
    {
      kind: "status",
      label: "Vector",
      value: status.vectorAvailable
        ? "available"
        : `unavailable (${status.vectorError ?? "unknown"})`,
    },
  ];
}

function badge(label: string, tone: "neutral" | "ok" | "warn" | "error"): string {
  switch (tone) {
    case "ok":
      return `{black-fg}{green-bg} ${label} {/}`;
    case "warn":
      return `{black-fg}{yellow-bg} ${label} {/}`;
    case "error":
      return `{white-fg}{red-bg} ${label} {/}`;
    default:
      return `{black-fg}{white-bg} ${label} {/}`;
  }
}

export function formatHeader(model: TuiHeaderModel, now = new Date()): string {
  const status = model.status;
  const segments = [
    badge(model.activeModeLabel, "neutral"),
    badge(`repo ${model.repo}`, "neutral"),
    badge(`db ${truncate(model.dbPath, 48)}`, "neutral"),
  ];
  if (status) {
    segments.push(
      badge(`pr ${formatRelativeAge(status.lastSyncAt, now)}`, status.lastSyncAt ? "ok" : "warn"),
    );
    segments.push(
      badge(
        `issue ${formatRelativeAge(status.issueLastSyncAt, now)}`,
        status.issueLastSyncAt ? "ok" : "warn",
      ),
    );
    segments.push(
      badge(
        status.vectorAvailable ? "vector ok" : `vector ${status.vectorError ?? "off"}`,
        status.vectorAvailable ? "ok" : "warn",
      ),
    );
  }
  if (model.ftsOnly) {
    segments.push(badge("fts only", "warn"));
  }
  if (model.busyMessage) {
    segments.push(badge(model.busyMessage, "warn"));
  } else if (model.errorMessage) {
    segments.push(badge("error", "error"));
  }
  return segments.join(" ");
}

export function formatModeRail(activeMode: string, focus: TuiFocus): string[] {
  return TUI_MODE_ORDER.map((mode) => {
    const selected = mode.id === activeMode;
    const prefix = selected ? ">" : " ";
    const label = `${prefix} ${mode.label}`.padEnd(16);
    if (!selected) {
      return label;
    }
    if (focus === "nav") {
      return `{black-fg}{cyan-bg}${label}{/}`;
    }
    return `{cyan-fg}${label}{/}`;
  });
}

export function formatResults(model: TuiRenderModel): string[] {
  if (model.rows.length === 0) {
    return ["No rows.", "Press / to search this view."];
  }
  return model.rows.map((row, index) => {
    const line = formatResultRow(row);
    if (index !== model.selectedIndex) {
      return `  ${line}`;
    }
    if (model.focus === "results") {
      return `{black-fg}{cyan-bg}> ${line}{/}`;
    }
    return `{cyan-fg}> ${line}{/}`;
  });
}

export function defaultHintText(): string {
  return "Tab focus | / query | Enter inspect | x xref | c cluster | s/S sync | r facts | o open | b back | q quit";
}
