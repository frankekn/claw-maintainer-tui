import type {
  ClusterCandidate,
  ClusterExcludedCandidate,
  IssueSearchResult,
  SearchResult,
  StatusSnapshot,
} from "../types.js";
import {
  TUI_THEME,
  actionChip,
  badge,
  section as sectionLabel,
  selectedLine,
  text,
  valueTone,
} from "./theme.js";
import { TUI_MODE_ORDER } from "./types.js";
import type {
  TuiAction,
  TuiFocus,
  TuiHeaderModel,
  TuiListSummary,
  TuiRenderModel,
  TuiResultRow,
} from "./types.js";

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

function padRight(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function formatState(value: string): string {
  return padRight(value.toUpperCase(), 6);
}

function freshnessTone(value: string | null, now = new Date()): "ok" | "warn" {
  if (!value) {
    return "warn";
  }
  const then = new Date(value);
  const diffMs = Math.max(0, now.getTime() - then.getTime());
  return diffMs < 1000 * 60 * 60 * 12 ? "ok" : "warn";
}

function stateTone(value: string): "ok" | "warn" | "error" | "muted" {
  switch (value.toLowerCase()) {
    case "open":
      return "ok";
    case "merged":
      return "warn";
    case "closed":
      return "muted";
    default:
      return "muted";
  }
}

function accentMeta(label: string, value: string): string {
  return `${text(label, "muted")} ${value}`;
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
    `${text(`PR #${pr.prNumber}`, "accent")} ${pr.title}`,
    `${valueTone(formatState(pr.state).trim(), stateTone(pr.state))}  ${text(pr.author, "muted")}  ${text(pr.updatedAt, "dim")}`,
    accentMeta("labels", formatLabelBlock(pr.labels)),
    accentMeta("github", pr.url),
    "",
    sectionLabel("Summary"),
    truncate(pr.matchedExcerpt, 560),
  ];
  if (comments.length > 0) {
    lines.push("", `${sectionLabel("Comments")} ${text(`(${comments.length})`, "muted")}`);
    for (const comment of comments) {
      lines.push(
        `- ${text(`[${comment.kind}]`, "muted")} ${comment.author} ${text(comment.createdAt, "dim")}`,
      );
      lines.push(`  ${truncate(comment.excerpt, 200)}`);
    }
  }
  return lines.join("\n");
}

export function formatIssueDetail(issue: IssueSearchResult): string {
  return [
    `${text(`Issue #${issue.issueNumber}`, "accent")} ${issue.title}`,
    `${valueTone(formatState(issue.state).trim(), stateTone(issue.state))}  ${text(issue.author, "muted")}  ${text(issue.updatedAt, "dim")}`,
    accentMeta("labels", formatLabelBlock(issue.labels)),
    accentMeta("github", issue.url),
    "",
    sectionLabel("Summary"),
    truncate(issue.matchedExcerpt, 560),
  ].join("\n");
}

export function formatClusterDetail(
  analysis: {
    seedLabel: string;
    clusterBasis: string;
    clusterIssues: number[];
    mergeSummary: string | null;
    coverageSummary: string | null;
  },
  candidate: ClusterCandidate | ClusterExcludedCandidate,
): string {
  const lines = [
    sectionLabel("Seed"),
    analysis.seedLabel,
    "",
    sectionLabel("Cluster"),
    `${text("cluster_basis", "muted")} ${analysis.clusterBasis}`,
    `${text("cluster_issues", "muted")} ${
      analysis.clusterIssues.length > 0
        ? analysis.clusterIssues.map((issue) => `#${issue}`).join(", ")
        : "(none)"
    }`,
  ];
  if (analysis.mergeSummary) {
    lines.push(`${text("merge_readiness", "muted")} ${valueTone(analysis.mergeSummary, "warn")}`);
  }
  if (analysis.coverageSummary) {
    lines.push(`${text("coverage", "muted")} ${valueTone(analysis.coverageSummary, "ok")}`);
  }
  lines.push("");
  if ("excludedReasonCode" in candidate) {
    lines.push(sectionLabel("Excluded Candidate"));
    lines.push(`${text("excluded_candidate", "muted")} #${candidate.prNumber} ${candidate.title}`);
    lines.push(`${text("matched_by", "muted")} ${candidate.matchedBy}`);
    lines.push(`${text("reason", "muted")} ${valueTone(candidate.reason, "warn")}`);
    lines.push(
      `${text("linked_issues", "muted")} ${candidate.linkedIssues.map((issue) => `#${issue}`).join(", ") || "(none)"}`,
    );
    if (candidate.semanticScore !== undefined) {
      lines.push(`${text("semantic_score", "muted")} ${candidate.semanticScore.toFixed(2)}`);
    }
  } else {
    lines.push(sectionLabel("Candidate"));
    lines.push(`${text("candidate", "muted")} #${candidate.prNumber} ${candidate.title}`);
    lines.push(`${text("status", "muted")} ${valueTone(candidate.status, "ok")}`);
    lines.push(`${text("matched_by", "muted")} ${candidate.matchedBy}`);
    lines.push(
      `${text("relevant_prod", "muted")} ${candidate.relevantProdFiles.length}/${candidate.prodFiles.length}`,
    );
    lines.push(
      `${text("relevant_test", "muted")} ${candidate.relevantTestFiles.length}/${candidate.testFiles.length}`,
    );
    lines.push(`${text("noise", "muted")} ${candidate.noiseFilesCount}`);
    lines.push(
      `${text("linked_issues", "muted")} ${candidate.linkedIssues.map((issue) => `#${issue}`).join(", ") || "(none)"}`,
    );
    if (candidate.supersededBy) {
      lines.push(`${text("superseded_by", "muted")} #${candidate.supersededBy}`);
    }
    if (candidate.reason) {
      lines.push(`${text("reason", "muted")} ${candidate.reason}`);
    }
  }
  return lines.join("\n");
}

export function formatContextCoverageDetail(
  title: string,
  yieldLabel: string | null,
  coverageLabel: string | null,
  body: string,
): string {
  const lines = [sectionLabel(title)];
  if (yieldLabel) {
    lines.push(`${text("hits", "muted")} ${valueTone(yieldLabel, "ok")}`);
  }
  if (coverageLabel) {
    lines.push(`${text("coverage", "muted")} ${coverageLabel}`);
  }
  lines.push("", body);
  return lines.join("\n");
}

export function formatStatusDetail(status: StatusSnapshot, now = new Date()): string {
  return [
    sectionLabel("Index Status"),
    accentMeta("repo", status.repo),
    accentMeta("last_sync_at", formatTimestamp(status.lastSyncAt)),
    `${text("last_sync_age", "muted")} ${valueTone(
      formatRelativeAge(status.lastSyncAt, now),
      freshnessTone(status.lastSyncAt, now),
    )}`,
    accentMeta("issue_last_sync_at", formatTimestamp(status.issueLastSyncAt)),
    `${text("issue_last_sync_age", "muted")} ${valueTone(
      formatRelativeAge(status.issueLastSyncAt, now),
      freshnessTone(status.issueLastSyncAt, now),
    )}`,
    "",
    sectionLabel("Counts"),
    accentMeta("prs", String(status.prCount)),
    accentMeta("issues", String(status.issueCount)),
    accentMeta("labels", String(status.labelCount)),
    accentMeta("issue_labels", String(status.issueLabelCount)),
    accentMeta("comments", String(status.commentCount)),
    accentMeta("docs", String(status.docCount)),
    "",
    sectionLabel("Vector"),
    `${text("vector_available", "muted")} ${valueTone(
      String(status.vectorAvailable),
      status.vectorAvailable ? "ok" : "warn",
    )}`,
    `${text("vector_error", "muted")} ${status.vectorError ?? "(none)"}`,
    accentMeta("embedding_model", status.embeddingModel),
    "",
    sectionLabel("Tips"),
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
  const inspectNoun = mode === "pr-search" ? "pull request" : "issue";
  const lines = [sectionLabel("Start Here"), `Active list: recent open ${plural}`];
  if (status) {
    lines.push(accentMeta("Repo", status.repo));
    lines.push(accentMeta("Local rows", String(count)));
    lines.push(
      `${text("Freshness", "muted")} ${valueTone(
        `PR ${formatRelativeAge(status.lastSyncAt, now)}`,
        freshnessTone(status.lastSyncAt, now),
      )}  ${valueTone(
        `Issue ${formatRelativeAge(status.issueLastSyncAt, now)}`,
        freshnessTone(status.issueLastSyncAt, now),
      )}`,
    );
    lines.push(
      `${text("Vector", "muted")} ${
        status.vectorAvailable
          ? valueTone("ready", "ok")
          : valueTone(status.vectorError ?? "unavailable", "warn")
      }`,
    );
  }
  lines.push(
    "",
    sectionLabel("Workflow"),
    `1 Search the ${noun} desk or browse the recent open ${plural.toLowerCase()}.`,
    `2 Inspect the selected ${inspectNoun}.`,
    mode === "pr-search"
      ? "3 Xref for linked issues, 4 Cluster for nearby fixes."
      : "3 Xref for linked pull requests.",
    "Use the action bar first. Power keys stay visible as secondary hints.",
  );
  return lines.join("\n");
}

export function buildStatusRows(status: StatusSnapshot): TuiResultRow[] {
  return [
    { kind: "status", label: text("PRs", "muted"), value: valueTone(String(status.prCount), "ok") },
    {
      kind: "status",
      label: text("Issues", "muted"),
      value: valueTone(String(status.issueCount), "ok"),
    },
    {
      kind: "status",
      label: text("PR Labels", "muted"),
      value: text(String(status.labelCount), "primary"),
    },
    {
      kind: "status",
      label: text("Issue Labels", "muted"),
      value: text(String(status.issueLabelCount), "primary"),
    },
    {
      kind: "status",
      label: text("Comments", "muted"),
      value: text(String(status.commentCount), "primary"),
    },
    {
      kind: "status",
      label: text("Docs", "muted"),
      value: text(String(status.docCount), "primary"),
    },
    {
      kind: "status",
      label: text("Vector", "muted"),
      value: status.vectorAvailable
        ? valueTone("available", "ok")
        : valueTone(`unavailable (${status.vectorError ?? "unknown"})`, "warn"),
    },
  ];
}

export function formatHeader(model: TuiHeaderModel, now = new Date()): string {
  const status = model.status;
  const segments = [
    badge(`MODE ${model.activeModeLabel}`, "focus"),
    badge(`REPO ${model.repo}`, "neutral"),
    badge(`DB ${truncate(model.dbPath, 36)}`, "neutral"),
  ];
  if (status) {
    segments.push(
      badge(
        `PR ${formatRelativeAge(status.lastSyncAt, now)}`,
        freshnessTone(status.lastSyncAt, now),
      ),
    );
    segments.push(
      badge(
        `ISSUE ${formatRelativeAge(status.issueLastSyncAt, now)}`,
        freshnessTone(status.issueLastSyncAt, now),
      ),
    );
    segments.push(
      badge(
        status.vectorAvailable ? "VECTOR READY" : `VECTOR ${status.vectorError ?? "OFF"}`,
        status.vectorAvailable ? "ok" : "warn",
      ),
    );
  }
  if (model.ftsOnly) {
    segments.push(badge("FTS ONLY", "warn"));
  }
  if (model.busyMessage) {
    segments.push(badge(model.busyMessage.toUpperCase(), "warn"));
  } else if (model.errorMessage) {
    segments.push(badge("ERROR", "error"));
  }
  return segments.join(" ");
}

export function formatActionBar(actions: TuiAction[]): string {
  return actions
    .map((action) => actionChip(`${action.slot} ${action.label}`, action.enabled))
    .join(` ${text("·", "dim")} `);
}

export function formatListSummary(summary: TuiListSummary | null): string {
  if (!summary) {
    return "";
  }
  const segments = [valueTone(summary.yieldLabel, "ok")];
  if (summary.confidenceLabel) {
    segments.push(`${text("confidence", "muted")} ${summary.confidenceLabel}`);
  }
  if (summary.coverageLabel) {
    segments.push(`${text("coverage", "muted")} ${summary.coverageLabel}`);
  }
  return segments.join(` ${text("·", "dim")} `);
}

export function formatModeRail(activeMode: string, focus: TuiFocus): string[] {
  return TUI_MODE_ORDER.map((mode) => {
    const selected = mode.id === activeMode;
    const prefix = selected ? ">" : " ";
    const label = `${prefix} ${mode.label}`.padEnd(TUI_THEME.layout.navWidth);
    if (!selected) {
      return text(label, focus === "nav" ? "dim" : "muted");
    }
    return selectedLine(label, focus === "nav");
  });
}

export function formatResults(model: TuiRenderModel): string[] {
  if (model.rows.length === 0) {
    return [text("No rows.", "muted"), text("Press / to search this view.", "dim")];
  }
  return model.rows.map((row, index) => {
    const line = formatResultRow(row);
    if (index !== model.selectedIndex) {
      return `${text("  ", "dim")}${line}`;
    }
    return selectedLine(`> ${line}`, model.focus === "results");
  });
}

export function defaultSecondaryHintText(): string {
  return `${text("Move", "muted")} j/k ↑↓  ${text("Enter", "muted")} inspect  ${text("b", "muted")} back  ${text("q", "muted")} quit`;
}
