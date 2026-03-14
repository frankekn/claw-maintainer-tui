import type {
  ClusterCandidate,
  ClusterExcludedCandidate,
  IssueSearchResult,
  PrContextBundle,
  PriorityCandidate,
  SearchResult,
  StatusSnapshot,
} from "../../types.js";
import { section as sectionLabel, text, valueTone } from "../theme.js";
import type { TuiDetailPaneModel, TuiDetailPayload, TuiDetailSection, TuiMode } from "../types.js";
import { formatFreshnessLabel, formatRelativeAge, formatStatusTimestampLabel } from "./chrome.js";

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
    default:
      return "muted";
  }
}

function accentMeta(label: string, value: string): string {
  return `${text(label, "muted")} ${value}`;
}

function formatLabelBlock(labels: string[]): string {
  return labels.length > 0 ? labels.join(", ") : "(none)";
}

function formatPrioritySummary(candidate: PriorityCandidate): string[] {
  const badges = [
    candidate.badges.draft ? "draft" : "",
    candidate.badges.maintainer ? "maintainer" : "",
  ].filter(Boolean);
  return [
    `${text(`PR #${candidate.pr.prNumber}`, "accent")} ${candidate.pr.title}`,
    `${valueTone(candidate.pr.state.toUpperCase(), stateTone(candidate.pr.state))}  ${text(candidate.pr.author, "muted")}  ${text(candidate.pr.updatedAt, "dim")}`,
    accentMeta("labels", formatLabelBlock(candidate.pr.labels)),
    accentMeta("github", candidate.pr.url),
    accentMeta("attention", candidate.attentionState),
    accentMeta("priority_score", String(candidate.score)),
    accentMeta("badges", badges.length > 0 ? badges.join(", ") : "(none)"),
  ];
}

function formatReasonLines(reasons: PriorityCandidate["reasons"]): string[] {
  if (reasons.length === 0) {
    return ["- open PR fallback"];
  }
  return reasons.map((reason) => `- ${reason.label} ${text(`(+${reason.points})`, "muted")}`);
}

function appendSection(
  lines: string[],
  anchors: Partial<Record<TuiDetailSection, number>>,
  section: TuiDetailSection,
  title: string,
  body: string[],
): void {
  if (lines.length > 0) {
    lines.push("");
  }
  anchors[section] = lines.length;
  lines.push(sectionLabel(title));
  lines.push(...body);
}

export function formatPrDetail(
  pr: SearchResult,
  comments: Array<{ kind: string; author: string; createdAt: string; excerpt: string }>,
): string[] {
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
  return lines;
}

export function formatPriorityPrDetail(
  bundle: PrContextBundle,
  focusSection: TuiDetailSection | null = null,
): { lines: string[]; anchorLine: number | null } {
  const lines = formatPrioritySummary(bundle.candidate);
  const anchors: Partial<Record<TuiDetailSection, number>> = {};
  appendSection(lines, anchors, "summary", "Summary", [
    truncate(bundle.candidate.pr.matchedExcerpt, 520),
  ]);
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(sectionLabel("Why Prioritized"));
  lines.push(...formatReasonLines(bundle.candidate.reasons));
  appendSection(lines, anchors, "linked-issues", "Linked Issues", [
    `${text("count", "muted")} ${bundle.linkedIssues.length}`,
    ...(bundle.linkedIssues.length > 0
      ? bundle.linkedIssues.map((issue) => `- #${issue.issueNumber} ${issue.title}`)
      : ["(none)"]),
  ]);
  appendSection(lines, anchors, "related-prs", "Related PRs", [
    `${text("count", "muted")} ${bundle.relatedPullRequests.length}`,
    ...(bundle.relatedPullRequests.length > 0
      ? bundle.relatedPullRequests.map((pr) => `- #${pr.prNumber} ${pr.title}`)
      : ["(none)"]),
  ]);
  const clusterCandidates =
    (bundle.cluster?.sameClusterCandidates.length ?? 0) +
    (bundle.cluster?.nearbyButExcluded.length ?? 0);
  appendSection(lines, anchors, "cluster", "Cluster", [
    bundle.cluster
      ? `${text("basis", "muted")} ${bundle.cluster.clusterBasis}`
      : `${text("basis", "muted")} (none)`,
    bundle.cluster && bundle.cluster.clusterIssueNumbers.length > 0
      ? `${text("issues", "muted")} ${bundle.cluster.clusterIssueNumbers.map((issue) => `#${issue}`).join(", ")}`
      : `${text("issues", "muted")} (none)`,
    `${text("rows", "muted")} ${clusterCandidates}`,
    ...(bundle.cluster?.sameClusterCandidates.length
      ? bundle.cluster.sameClusterCandidates.map(
          (candidate) => `- #${candidate.prNumber} ${candidate.title}`,
        )
      : ["(none)"]),
  ]);
  appendSection(lines, anchors, "maintainer-state", "Maintainer State", [
    `${text("attention", "muted")} ${bundle.candidate.attentionState}`,
    `${text("watchlist", "muted")} ${bundle.candidate.attentionState === "watch" ? "yes" : "no"}`,
    `${text("ignore", "muted")} ${bundle.candidate.attentionState === "ignore" ? "yes" : "no"}`,
  ]);
  if (bundle.comments.length > 0 || bundle.latestReviewFact || bundle.mergeReadiness) {
    lines.push("", sectionLabel("Sparse Extras"));
    if (bundle.comments.length > 0) {
      lines.push(`${text("recent_comments", "muted")} ${bundle.comments.length}`);
      for (const comment of bundle.comments) {
        lines.push(`- [${comment.kind}] ${comment.author}: ${truncate(comment.excerpt, 120)}`);
      }
    }
    if (bundle.latestReviewFact) {
      lines.push(
        `${text("latest_review_fact", "muted")} ${bundle.latestReviewFact.decision} · ${bundle.latestReviewFact.summary}`,
      );
    }
    if (bundle.mergeReadiness) {
      lines.push(
        `${text("merge_readiness", "muted")} ${bundle.mergeReadiness.state} via ${bundle.mergeReadiness.source}`,
      );
      lines.push(`  ${truncate(bundle.mergeReadiness.summary, 160)}`);
    }
  }
  return { lines, anchorLine: focusSection ? (anchors[focusSection] ?? 0) : null };
}

export function formatIssueDetail(issue: IssueSearchResult): string[] {
  return [
    `${text(`Issue #${issue.issueNumber}`, "accent")} ${issue.title}`,
    `${valueTone(issue.state.toUpperCase(), stateTone(issue.state))}  ${text(issue.author, "muted")}  ${text(issue.updatedAt, "dim")}`,
    accentMeta("labels", formatLabelBlock(issue.labels)),
    accentMeta("github", issue.url),
    "",
    sectionLabel("Summary"),
    truncate(issue.matchedExcerpt, 520),
  ];
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
): string[] {
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
  return lines;
}

export function formatStatusDetail(status: StatusSnapshot, now = new Date()): string[] {
  return [
    sectionLabel("Index"),
    accentMeta("repo", status.repo),
    formatStatusTimestampLabel("last_sync_at", status.lastSyncAt),
    formatFreshnessLabel("last_sync_age", status.lastSyncAt, now),
    formatStatusTimestampLabel("issue_last_sync_at", status.issueLastSyncAt),
    formatFreshnessLabel("issue_last_sync_age", status.issueLastSyncAt, now),
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
  ];
}

export function formatCrossSearchLandingDetail(
  status: StatusSnapshot | null,
  now = new Date(),
): string[] {
  const lines = [sectionLabel("Start Here"), "Explore shows cached PRs and issues in one list."];
  if (status) {
    lines.push(accentMeta("repo", status.repo));
    lines.push(
      `${text("freshness", "muted")} ${valueTone(`PR ${formatRelativeAge(status.lastSyncAt, now)}`, "ok")}  ${valueTone(
        `Issue ${formatRelativeAge(status.issueLastSyncAt, now)}`,
        "ok",
      )}`,
    );
  }
  lines.push(
    "",
    sectionLabel("Workflow"),
    "1 Browse the cached list or press / to refine it.",
    "2 Press Enter to open the selected detail drawer.",
    "3 Press m to load 20 more rows.",
    "4 Use x or c to jump to linked issues or cluster context.",
  );
  return lines;
}

export function formatInboxLandingDetail(
  status: StatusSnapshot | null,
  now = new Date(),
): string[] {
  const lines = [
    sectionLabel("Start Here"),
    "Inbox ranks PRs by how much context they can open up.",
  ];
  if (status) {
    lines.push(accentMeta("repo", status.repo));
    lines.push(
      `${text("freshness", "muted")} ${valueTone(`PR ${formatRelativeAge(status.lastSyncAt, now)}`, "ok")}`,
    );
  }
  lines.push(
    "",
    sectionLabel("Workflow"),
    "1 Review the single priority queue.",
    "2 Press Enter to open the PR investigation workspace.",
    "3 Press x or c to jump to linked issues or cluster.",
    "4 Press v / w / i / u to manage local triage state.",
  );
  return lines;
}

export function formatWatchlistLandingDetail(
  status: StatusSnapshot | null,
  now = new Date(),
): string[] {
  const lines = [sectionLabel("Start Here"), "Watchlist is your revisit queue for open PRs."];
  if (status) {
    lines.push(accentMeta("repo", status.repo));
    lines.push(
      `${text("freshness", "muted")} ${valueTone(formatRelativeAge(status.lastSyncAt, now), "ok")}`,
    );
  }
  lines.push(
    "",
    sectionLabel("Workflow"),
    "1 Review watched PRs in one list.",
    "2 Press Enter to open the PR investigation workspace.",
    "3 Press u to clear local watch state when you are done.",
  );
  return lines;
}

export function formatSearchLandingDetail(
  mode: "pr-search" | "issue-search",
  status: StatusSnapshot | null,
  now = new Date(),
): string[] {
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
        "ok",
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
  return lines;
}

export function buildDetailPaneModel(input: {
  payload: TuiDetailPayload;
  visible: boolean;
  status: string | null;
  identity: string | null;
  anchorKey: string | null;
  focusSection: TuiDetailSection | null;
}): TuiDetailPaneModel {
  const { payload, visible, status, identity, anchorKey, focusSection } = input;
  switch (payload.kind) {
    case "pr": {
      const formatted = formatPriorityPrDetail(payload.bundle, focusSection);
      return {
        visible,
        title: `PR #${payload.bundle.candidate.pr.prNumber}`,
        status,
        lines: formatted.lines,
        identity,
        anchorLine: formatted.anchorLine,
        anchorKey,
      };
    }
    case "issue":
      return {
        visible,
        title: `Issue #${payload.issue.issueNumber}`,
        status,
        lines: formatIssueDetail(payload.issue),
        identity,
        anchorLine: null,
        anchorKey,
      };
    case "status":
      return {
        visible,
        title: "Repository Status",
        status,
        lines: payload.status
          ? formatStatusDetail(payload.status)
          : ["Loading repository status..."],
        identity,
        anchorLine: null,
        anchorKey,
      };
    case "landing":
    default: {
      const lines =
        payload.mode === "inbox"
          ? formatInboxLandingDetail(payload.status)
          : payload.mode === "watchlist"
            ? formatWatchlistLandingDetail(payload.status)
            : payload.mode === "cross-search"
              ? formatCrossSearchLandingDetail(payload.status)
              : payload.mode === "pr-search" || payload.mode === "issue-search"
                ? formatSearchLandingDetail(payload.mode, payload.status)
                : payload.status
                  ? formatStatusDetail(payload.status)
                  : ["Loading repository status..."];
      return {
        visible,
        title: payload.mode === "status" ? "Repository Status" : "Start Here",
        status,
        lines,
        identity,
        anchorLine: null,
        anchorKey,
      };
    }
  }
}
