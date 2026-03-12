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

function formatPrRow(result: SearchResult): string {
  return `#${result.prNumber} ${truncate(result.title, 78)} [${result.state}] ${result.score.toFixed(3)}`;
}

function formatIssueRow(result: IssueSearchResult): string {
  return `#${result.issueNumber} ${truncate(result.title, 78)} [${result.state}] ${result.score.toFixed(3)}`;
}

function formatClusterCandidateRow(candidate: ClusterCandidate): string {
  const extras = [
    candidate.status,
    `by:${candidate.matchedBy}`,
    `prod:${candidate.relevantProdFiles.length}/${candidate.prodFiles.length}`,
    `test:${candidate.relevantTestFiles.length}/${candidate.testFiles.length}`,
    `noise:${candidate.noiseFilesCount}`,
  ];
  return `#${candidate.prNumber} ${truncate(candidate.title, 52)} ${extras.join(" ")}`;
}

function formatClusterExcludedRow(candidate: ClusterExcludedCandidate): string {
  const scoreSuffix =
    candidate.semanticScore !== undefined ? ` score:${candidate.semanticScore.toFixed(2)}` : "";
  return `#${candidate.prNumber} ${truncate(candidate.title, 58)} excluded:${candidate.excludedReasonCode}${scoreSuffix}`;
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
    `state: ${pr.state}`,
    `author: ${pr.author}`,
    `updated_at: ${pr.updatedAt}`,
    `labels: ${formatLabelBlock(pr.labels)}`,
    `url: ${pr.url}`,
    "",
    truncate(pr.matchedExcerpt, 560),
  ];
  if (comments.length > 0) {
    lines.push("", "comments:");
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
    `state: ${issue.state}`,
    `author: ${issue.author}`,
    `updated_at: ${issue.updatedAt}`,
    `labels: ${formatLabelBlock(issue.labels)}`,
    `url: ${issue.url}`,
    "",
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
    analysis.seedLabel,
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
    `repo: ${status.repo}`,
    `last_sync_at: ${formatTimestamp(status.lastSyncAt)}`,
    `last_sync_age: ${formatRelativeAge(status.lastSyncAt, now)}`,
    `issue_last_sync_at: ${formatTimestamp(status.issueLastSyncAt)}`,
    `issue_last_sync_age: ${formatRelativeAge(status.issueLastSyncAt, now)}`,
    `prs: ${status.prCount}`,
    `issues: ${status.issueCount}`,
    `labels: ${status.labelCount}`,
    `issue_labels: ${status.issueLabelCount}`,
    `comments: ${status.commentCount}`,
    `docs: ${status.docCount}`,
    `vector_available: ${status.vectorAvailable}`,
    `vector_error: ${status.vectorError ?? "(none)"}`,
    `embedding_model: ${status.embeddingModel}`,
  ].join("\n");
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
    const label = `${prefix} ${mode.label}`;
    if (!selected) {
      return label;
    }
    if (focus === "nav") {
      return `{black-fg}{cyan-bg}${label.padEnd(14)}{/}`;
    }
    return `{cyan-fg}${label}{/}`;
  });
}

export function formatResults(model: TuiRenderModel): string[] {
  if (model.rows.length === 0) {
    return ["(no rows)"];
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
  return "Tab focus  / query  Enter open  x xref  c cluster  s/S sync  r refresh facts  o open URL  b back  q quit";
}
