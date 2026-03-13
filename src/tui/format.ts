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
  keyLabel,
  section as sectionLabel,
  selectedLine,
  tabChip,
  text,
  valueTone,
} from "./theme.js";
import { TUI_MODE_ORDER } from "./types.js";
import type {
  TuiAction,
  TuiFocus,
  TuiFreshness,
  TuiHeaderModel,
  TuiListSummary,
  TuiRenderModel,
  TuiResultRow,
  TuiVerificationState,
} from "./types.js";

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

function stateTone(value: string): "ok" | "warn" | "error" | "muted" {
  switch (value.toLowerCase()) {
    case "open":
    case "ready":
    case "verified":
      return "ok";
    case "merged":
    case "partial":
    case "verifying":
      return "warn";
    case "rate-limited":
      return "error";
    case "closed":
    case "cached":
    case "stale":
    case "excluded":
      return "muted";
    default:
      return "muted";
  }
}

function freshnessTone(value: string | null, now = new Date()): "ok" | "warn" {
  if (!value) {
    return "warn";
  }
  const then = new Date(value);
  const diffMs = Math.max(0, now.getTime() - then.getTime());
  return diffMs < 1000 * 60 * 60 * 12 ? "ok" : "warn";
}

function accentMeta(label: string, value: string): string {
  return `${text(label, "muted")} ${value}`;
}

function formatFreshness(freshness: TuiFreshness): string {
  return padRight(freshness.toUpperCase(), 7);
}

function formatVerification(value: TuiVerificationState): string {
  switch (value) {
    case "done":
      return padRight("VERIFIED", 11);
    case "running":
      return padRight("VERIFYING", 11);
    case "rate_limited":
      return padRight("RATE-LIMIT", 11);
    default:
      return padRight("CACHED", 11);
  }
}

function formatKind(kind: TuiResultRow["kind"]): string {
  switch (kind) {
    case "pr":
      return "PR";
    case "issue":
      return "ISSUE";
    case "cluster-candidate":
      return "CLUSTER";
    case "cluster-excluded":
      return "CLUSTER";
    default:
      return "STATUS";
  }
}

function formatDateShort(value: string): string {
  return value.slice(0, 10);
}

function formatPrRow(row: Extract<TuiResultRow, { kind: "pr" }>): string {
  const result = row.pr;
  return `${padRight(formatKind(row.kind), 8)} ${padRight(`#${result.prNumber}`, 9)} ${result.score
    .toFixed(3)
    .padStart(5)} ${padRight(result.state.toUpperCase(), 9)} ${padRight(
    formatFreshness(row.freshness),
    7,
  )} ${padRight(formatDateShort(result.updatedAt), 10)} ${truncate(result.title, 54)}`;
}

function formatIssueRow(row: Extract<TuiResultRow, { kind: "issue" }>): string {
  const result = row.issue;
  return `${padRight(formatKind(row.kind), 8)} ${padRight(`#${result.issueNumber}`, 9)} ${result.score
    .toFixed(3)
    .padStart(5)} ${padRight(result.state.toUpperCase(), 9)} ${padRight(
    formatFreshness(row.freshness),
    7,
  )} ${padRight(formatDateShort(result.updatedAt), 10)} ${truncate(result.title, 54)}`;
}

function formatClusterCandidateRow(
  row: Extract<TuiResultRow, { kind: "cluster-candidate" }>,
): string {
  const candidate = row.candidate;
  const status =
    candidate.status === "best_base"
      ? "BEST"
      : candidate.status === "superseded_candidate"
        ? "SUPER"
        : "POSSIB";
  return `${padRight(formatKind(row.kind), 8)} ${padRight(`#${candidate.prNumber}`, 9)} ${padRight(
    candidate.matchedBy,
    11,
  )} ${padRight(status, 9)} ${formatVerification(row.verification)} ${padRight(
    formatDateShort(candidate.updatedAt),
    10,
  )} ${truncate(candidate.title, 46)}`;
}

function formatClusterExcludedRow(
  row: Extract<TuiResultRow, { kind: "cluster-excluded" }>,
): string {
  const candidate = row.candidate;
  return `${padRight(formatKind(row.kind), 8)} ${padRight(`#${candidate.prNumber}`, 9)} ${padRight(
    candidate.matchedBy,
    11,
  )} ${padRight("EXCLUDED", 9)} ${formatVerification(row.verification)} ${padRight(
    formatDateShort(candidate.updatedAt),
    10,
  )} ${truncate(candidate.title, 46)}`;
}

export function formatResultRow(row: TuiResultRow): string {
  switch (row.kind) {
    case "pr":
      return formatPrRow(row);
    case "issue":
      return formatIssueRow(row);
    case "cluster-candidate":
      return formatClusterCandidateRow(row);
    case "cluster-excluded":
      return formatClusterExcludedRow(row);
    case "status":
      return `${row.label}: ${row.value}`;
    default:
      return "";
  }
}

function formatTableHeader(mode: string): string {
  if (mode === "cluster") {
    return text(
      `${padRight("Kind", 8)} ${padRight("ID", 9)} ${padRight("Match", 11)} ${padRight(
        "State",
        9,
      )} ${padRight("Verify", 11)} ${padRight("Updated", 10)} Title`,
      "dim",
    );
  }
  return text(
    `${padRight("Kind", 8)} ${padRight("ID", 9)} ${padRight("Score", 5)} ${padRight(
      "State",
      9,
    )} ${padRight("Fresh", 7)} ${padRight("Updated", 10)} Title`,
    "dim",
  );
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
    `${valueTone(pr.state.toUpperCase(), stateTone(pr.state))}  ${text(pr.author, "muted")}  ${text(pr.updatedAt, "dim")}`,
    accentMeta("labels", formatLabelBlock(pr.labels)),
    accentMeta("github", pr.url),
    "",
    sectionLabel("Summary"),
    truncate(pr.matchedExcerpt, 520),
  ];
  if (comments.length > 0) {
    lines.push("", `${sectionLabel("Comments")} ${text(`(${comments.length})`, "muted")}`);
    for (const comment of comments) {
      lines.push(
        `- ${text(`[${comment.kind}]`, "muted")} ${comment.author} ${text(comment.createdAt, "dim")}`,
      );
      lines.push(`  ${truncate(comment.excerpt, 180)}`);
    }
  }
  return lines.join("\n");
}

export function formatIssueDetail(issue: IssueSearchResult): string {
  return [
    `${text(`Issue #${issue.issueNumber}`, "accent")} ${issue.title}`,
    `${valueTone(issue.state.toUpperCase(), stateTone(issue.state))}  ${text(issue.author, "muted")}  ${text(issue.updatedAt, "dim")}`,
    accentMeta("labels", formatLabelBlock(issue.labels)),
    accentMeta("github", issue.url),
    "",
    sectionLabel("Summary"),
    truncate(issue.matchedExcerpt, 520),
  ].join("\n");
}

export function formatClusterDetail(
  analysis: {
    seedLabel: string;
    clusterBasis: string;
    clusterIssues: number[];
    verificationSummary: string | null;
    mergeSummary: string | null;
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
  if (analysis.verificationSummary) {
    lines.push(`${text("verification", "muted")} ${analysis.verificationSummary}`);
  }
  if (analysis.mergeSummary) {
    lines.push(`${text("merge_readiness", "muted")} ${analysis.mergeSummary}`);
  }
  lines.push("");
  if ("excludedReasonCode" in candidate) {
    lines.push(sectionLabel("Excluded"));
    lines.push(`${text("candidate", "muted")} #${candidate.prNumber} ${candidate.title}`);
    lines.push(`${text("matched_by", "muted")} ${candidate.matchedBy}`);
    lines.push(`${text("reason", "muted")} ${candidate.reason}`);
  } else {
    lines.push(sectionLabel("Candidate"));
    lines.push(`${text("candidate", "muted")} #${candidate.prNumber} ${candidate.title}`);
    lines.push(`${text("status", "muted")} ${candidate.status}`);
    lines.push(`${text("matched_by", "muted")} ${candidate.matchedBy}`);
    lines.push(
      `${text("linked_issues", "muted")} ${candidate.linkedIssues.map((issue) => `#${issue}`).join(", ") || "(none)"}`,
    );
    lines.push(
      `${text("coverage", "muted")} prod ${candidate.relevantProdFiles.length}/${candidate.prodFiles.length}  test ${candidate.relevantTestFiles.length}/${candidate.testFiles.length}  noise ${candidate.noiseFilesCount}`,
    );
    if (candidate.reason) {
      lines.push(`${text("reason", "muted")} ${candidate.reason}`);
    }
  }
  return lines.join("\n");
}

export function formatStatusDetail(status: StatusSnapshot, now = new Date()): string {
  return [
    sectionLabel("Index"),
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
    `${text("vector", "muted")} ${status.vectorAvailable ? valueTone("ready", "ok") : valueTone(status.vectorError ?? "off", "warn")}`,
  ].join("\n");
}

export function formatCrossSearchLandingDetail(
  status: StatusSnapshot | null,
  now = new Date(),
): string {
  const lines = [sectionLabel("Start Here"), "Explore shows cached PRs and issues in one list."];
  if (status) {
    lines.push(accentMeta("repo", status.repo));
    lines.push(
      `${text("freshness", "muted")} ${valueTone(
        `PR ${formatRelativeAge(status.lastSyncAt, now)}`,
        freshnessTone(status.lastSyncAt, now),
      )}  ${valueTone(
        `Issue ${formatRelativeAge(status.issueLastSyncAt, now)}`,
        freshnessTone(status.issueLastSyncAt, now),
      )}`,
    );
  }
  lines.push(
    "",
    sectionLabel("Workflow"),
    "1 Browse the cached list or press / to refine it.",
    "2 Press Enter to open the selected detail drawer.",
    "3 Press m to load 20 more rows.",
    "4 Use Refresh only when you want full cluster verification.",
  );
  return lines.join("\n");
}

export function formatSearchLandingDetail(
  mode: "pr-search" | "issue-search",
  status: StatusSnapshot | null,
  now = new Date(),
): string {
  const noun = mode === "pr-search" ? "PR" : "issue";
  const plural = mode === "pr-search" ? "PRs" : "issues";
  const count = status ? (mode === "pr-search" ? status.prCount : status.issueCount) : null;
  const lines = [sectionLabel("Start Here"), `Showing cached open ${plural}`];
  if (status) {
    lines.push(accentMeta("repo", status.repo));
    lines.push(accentMeta("local_rows", String(count)));
    lines.push(
      `${text("freshness", "muted")} ${valueTone(
        mode === "pr-search"
          ? formatRelativeAge(status.lastSyncAt, now)
          : formatRelativeAge(status.issueLastSyncAt, now),
        mode === "pr-search"
          ? freshnessTone(status.lastSyncAt, now)
          : freshnessTone(status.issueLastSyncAt, now),
      )}`,
    );
  }
  lines.push(
    "",
    sectionLabel("Workflow"),
    `1 Browse open ${plural.toLowerCase()} or press / to search.`,
    `2 Press Enter to inspect the selected ${noun.toLowerCase()}.`,
    "3 Press m to load 20 more rows.",
  );
  return lines.join("\n");
}

export function formatClusterLandingDetail(prNumber: number, summary: string | null): string {
  return [
    sectionLabel("Cluster"),
    `Seed PR: #${prNumber}`,
    summary
      ? `${text("verification", "muted")} ${summary}`
      : `${text("verification", "muted")} cached only`,
    "",
    sectionLabel("Workflow"),
    "Press Enter to inspect a candidate.",
    "Press Refresh to verify the seed, nearby PRs, and linked issues on demand.",
  ].join("\n");
}

export function formatStatusRows(status: StatusSnapshot): TuiResultRow[] {
  return [
    { kind: "status", label: text("PRs", "muted"), value: valueTone(String(status.prCount), "ok") },
    {
      kind: "status",
      label: text("Issues", "muted"),
      value: valueTone(String(status.issueCount), "ok"),
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
        ? valueTone("ready", "ok")
        : valueTone(status.vectorError ?? "off", "warn"),
    },
  ];
}

export const buildStatusRows = formatStatusRows;

export function formatHeader(model: TuiHeaderModel, now = new Date()): string {
  const status = model.status;
  const segments = [
    badge(`MODE ${model.activeModeLabel}`, "focus"),
    badge(`REPO ${model.repo}`, "neutral"),
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
  }
  if (model.rateLimit) {
    segments.push(
      badge(
        `QUOTA ${model.rateLimit.remaining}/${model.rateLimit.limit}`,
        model.rateLimit.remaining > 0 ? "ok" : "error",
      ),
    );
    segments.push(badge(`RESET ${formatRelativeAge(model.rateLimit.resetAt, now)}`, "warn"));
  }
  if (model.syncMode) {
    segments.push(
      badge(
        model.syncMode === "metadata"
          ? "FAST SYNC"
          : model.syncMode === "detail"
            ? "DETAIL REFRESH"
            : "CLUSTER VERIFY",
        "warn",
      ),
    );
  }
  if (model.detailAutoRefreshInFlight) {
    segments.push(badge("DETAIL REFRESHING", "warn"));
  }
  if (model.ftsOnly) {
    segments.push(badge("FTS ONLY", "warn"));
  }
  if (model.errorMessage) {
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

export function formatModeTabs(activeMode: string, focus: TuiFocus): string {
  return TUI_MODE_ORDER.map((mode) =>
    tabChip(mode.label, mode.id === activeMode, focus === "nav" && mode.id === activeMode),
  ).join(` ${text(" ", "dim")}`);
}

export function formatResults(model: TuiRenderModel): string[] {
  if (model.rows.length === 0) {
    return [text("No rows.", "muted"), text("Press / to search this desk.", "dim")];
  }
  const lines = [formatTableHeader(model.mode)];
  lines.push(
    ...model.rows.map((row, index) => {
      const line = formatResultRow(row);
      if (index !== model.selectedIndex) {
        return `${text("  ", "dim")}${line}`;
      }
      return selectedLine(`> ${line}`, model.focus === "results");
    }),
  );
  return lines;
}

export function defaultSecondaryHintText(canLoadMore = false): string {
  return `${text("Move/Scroll", "muted")} j/k ↑↓  ${text("Enter", "muted")} detail  ${text("Tab", "muted")} focus  ${text("/", "muted")} query${canLoadMore ? `  ${text("m", "muted")} more` : ""}  ${text("q", "muted")} quit`;
}

export function formatDetailStatus(status: string | null): string {
  if (!status) {
    return "";
  }
  return `${keyLabel("DETAIL")} ${status}`;
}
