import type {
  TuiAction,
  TuiFocus,
  TuiHeaderModel,
  TuiListSummary,
  TuiSyncJobSnapshot,
} from "../types.js";
import { TUI_MODE_ORDER } from "../types.js";
import { badge, keyLabel, tabChip, text, valueTone } from "../theme.js";

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

function freshnessTone(value: string | null, now = new Date()): "ok" | "warn" {
  if (!value) {
    return "warn";
  }
  const then = new Date(value);
  const diffMs = Math.max(0, now.getTime() - then.getTime());
  return diffMs < 1000 * 60 * 60 * 12 ? "ok" : "warn";
}

function formatSyncJobBadge(job: TuiSyncJobSnapshot): string | null {
  const prefix = job.entity === "prs" ? "PR" : "ISSUE";
  if (job.state === "queued") {
    return badge(`${prefix} QUEUED`, "warn");
  }
  if (job.state === "error") {
    return badge(`${prefix} ERROR`, "error");
  }
  if (job.state !== "running" || !job.progress) {
    return null;
  }
  const countLabel =
    job.progress.totalKnown === null
      ? `${job.progress.processed}+${job.progress.skipped}`
      : `${job.progress.processed}/${job.progress.totalKnown}`;
  return badge(`${prefix} SYNC ${countLabel}`, "warn");
}

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
  for (const job of model.syncJobs) {
    const badgeText = formatSyncJobBadge(job);
    if (badgeText) {
      segments.push(badgeText);
    }
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
    .map(
      (action) =>
        `{${action.enabled ? "#2d3748" : "#48566a"}-bg}{${action.enabled ? "#edf2f7" : "#90a0b6"}-fg} ${action.slot} ${action.label} {/}`,
    )
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

export function defaultSecondaryHintText(mode: string, canLoadMore = false): string {
  const queryHint =
    mode === "cross-search" || mode === "pr-search" || mode === "issue-search"
      ? `  ${text("/", "muted")} query`
      : "";
  const triageHint =
    mode === "inbox" || mode === "watchlist"
      ? `  ${text("v/w/i/u", "muted")} triage  ${text("x/c", "muted")} context`
      : `  ${text("x/c", "muted")} context`;
  return `${text("Move/Scroll", "muted")} j/k ↑↓  ${text("Enter", "muted")} detail  ${text("Tab", "muted")} focus${queryHint}${triageHint}${canLoadMore ? `  ${text("m", "muted")} more` : ""}  ${text("q", "muted")} quit`;
}

export function formatDetailStatus(status: string | null): string {
  if (!status) {
    return "";
  }
  return `${keyLabel("DETAIL")} ${status}`;
}

export function formatStatusTimestampLabel(label: string, value: string | null): string {
  return `${text(label, "muted")} ${formatTimestamp(value)}`;
}

export function formatFreshnessLabel(
  label: string,
  value: string | null,
  now = new Date(),
): string {
  return `${text(label, "muted")} ${valueTone(formatRelativeAge(value, now), freshnessTone(value, now))}`;
}
