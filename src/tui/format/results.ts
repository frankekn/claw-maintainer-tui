import type { PriorityCandidate, SearchResult, StatusSnapshot } from "../../types.js";
import { selectedLine, text, valueTone } from "../theme.js";
import type {
  TuiFocus,
  TuiFreshness,
  TuiListSummary,
  TuiMode,
  TuiResultRow,
  TuiResultsPaneModel,
  TuiVerificationState,
} from "../types.js";
import { formatRelativeAge } from "./chrome.js";

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
    case "priority-cluster":
      return "CLUSTER";
    case "issue":
      return "ISSUE";
    case "cluster-candidate":
    case "cluster-excluded":
      return "CLUSTER";
    default:
      return "STATUS";
  }
}

function formatDateShort(value: string): string {
  return value.slice(0, 10);
}

function formatPriorityRow(candidate: PriorityCandidate): string {
  const reasons = candidate.reasons
    .slice(0, 3)
    .map((reason) => truncate(reason.label, 18))
    .join(" · ");
  const attention = candidate.attentionState.toUpperCase().padEnd(6);
  const badges = [candidate.badges.draft ? "D" : "", candidate.badges.maintainer ? "M" : ""]
    .filter(Boolean)
    .join("");
  const context = `I${candidate.linkedIssueCount} R${candidate.relatedPullRequestCount}`;
  return `${padRight("PR", 8)} ${padRight(`#${candidate.pr.prNumber}`, 9)} ${String(
    candidate.score,
  ).padStart(4)} ${padRight(attention, 7)} ${padRight(
    formatRelativeAge(candidate.pr.updatedAt),
    4,
  )} ${padRight(context, 7)} ${padRight(badges || "-", 3)} ${truncate(
    `${candidate.pr.title}${reasons ? ` · ${reasons}` : ""}`,
    64,
  )}`;
}

function formatPrRow(row: Extract<TuiResultRow, { kind: "pr" }>, mode: TuiMode): string {
  if ((mode === "inbox" || mode === "watchlist") && row.priority) {
    return formatPriorityRow(row.priority);
  }
  const result = row.pr;
  return `${padRight(formatKind(row.kind), 8)} ${padRight(`#${result.prNumber}`, 9)} ${result.score
    .toFixed(3)
    .padStart(5)} ${padRight(result.state.toUpperCase(), 9)} ${padRight(
    formatFreshness(row.freshness),
    7,
  )} ${padRight(formatDateShort(result.updatedAt), 10)} ${truncate(result.title, 54)}`;
}

function formatPriorityClusterRow(
  row: Extract<TuiResultRow, { kind: "priority-cluster" }>,
): string {
  const cluster = row.cluster;
  const representative = cluster.representative;
  const badge =
    cluster.recommendation === "merged_exists"
      ? "MRG"
      : cluster.recommendation === "open_variants"
        ? "VAR"
        : "SEM";
  const context = `P${cluster.totalPrCount} I${cluster.linkedIssueCount}`;
  return `${padRight(formatKind(row.kind), 8)} ${padRight(`#${representative.pr.prNumber}`, 9)} ${String(
    Math.round(cluster.score),
  ).padStart(4)} ${padRight(cluster.statusLabel.toUpperCase().slice(0, 7), 7)} ${padRight(
    formatRelativeAge(representative.pr.updatedAt),
    4,
  )} ${padRight(context, 7)} ${padRight(badge, 3)} ${truncate(
    `${representative.pr.title} · ${cluster.statusReason}`,
    64,
  )}`;
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

export function formatResultRow(row: TuiResultRow, mode: TuiMode): string {
  switch (row.kind) {
    case "pr":
      return formatPrRow(row, mode);
    case "priority-cluster":
      return formatPriorityClusterRow(row);
    case "issue":
      return formatIssueRow(row);
    case "cluster-candidate":
      return formatClusterCandidateRow(row);
    case "cluster-excluded":
      return formatClusterExcludedRow(row);
    case "status":
      return `${row.label}: ${row.value}`;
  }
}

function formatTableHeader(mode: TuiMode): string {
  if (mode === "inbox" || mode === "watchlist") {
    return text(
      `${padRight("Kind", 8)} ${padRight("ID", 9)} ${padRight("Score", 4)} ${padRight(
        "State",
        7,
      )} ${padRight("Age", 4)} ${padRight("Ctx", 7)} ${padRight("Tag", 3)} Title / reasons`,
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

export function buildResultsPaneModel(input: {
  mode: TuiMode;
  title: string;
  rows: TuiResultRow[];
  selectedIndex: number;
  focus: TuiFocus;
  summary: TuiListSummary | null;
  message: string;
}): TuiResultsPaneModel {
  const { mode, rows, selectedIndex, focus, title, summary, message } = input;
  if (rows.length === 0) {
    if (mode === "inbox") {
      return {
        title,
        summary,
        rows,
        selectedIndex,
        lines: /^Loading\b/.test(message)
          ? [
              text("Loading priority queue...", "muted"),
              text("Assembling cached PR context from the local index.", "dim"),
            ]
          : [
              text("No prioritized PRs.", "muted"),
              text("Background sync will repopulate the queue when metadata changes.", "dim"),
            ],
      };
    }
    if (mode === "watchlist") {
      return {
        title,
        summary,
        rows,
        selectedIndex,
        lines: /^Loading\b/.test(message)
          ? [text("Loading watchlist...", "muted"), text("Restoring local triage state.", "dim")]
          : [text("Watchlist is empty.", "muted"), text("Press w on a PR to pin it here.", "dim")],
      };
    }
    if (mode === "status") {
      return {
        title,
        summary,
        rows,
        selectedIndex,
        lines: [text("Loading repository status...", "muted")],
      };
    }
    return {
      title,
      summary,
      rows,
      selectedIndex,
      lines: [text("No rows.", "muted"), text("Press / to search this desk.", "dim")],
    };
  }

  const lines = [formatTableHeader(mode)];
  lines.push(
    ...rows.map((row, index) => {
      const line = formatResultRow(row, mode);
      if (index !== selectedIndex) {
        return `${text("  ", "dim")}${line}`;
      }
      return selectedLine(`> ${line}`, focus === "results");
    }),
  );
  return { title, summary, rows, selectedIndex, lines };
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

export const formatStatusRows = buildStatusRows;
