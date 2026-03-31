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
import type {
  TuiDetailFoldState,
  TuiDetailPaneModel,
  TuiDetailPayload,
  TuiDetailSection,
  TuiMode,
} from "../types.js";
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

function formatCoverageSummary(candidate: ClusterCandidate): string {
  return `prod ${candidate.relevantProdFiles.length}/${candidate.prodFiles.length}  test ${candidate.relevantTestFiles.length}/${candidate.testFiles.length}  noise ${candidate.noiseFilesCount}`;
}

function formatClusterCandidateLine(
  candidate: ClusterCandidate,
  marker: string,
  label: string,
): string {
  const reasonSummary =
    candidate.reasonCodes.length > 0
      ? candidate.reasonCodes.slice(0, 2).join(", ")
      : (candidate.reason ?? "cached");
  return `${marker} #${candidate.prNumber} ${candidate.title}  ${text(label, "muted")}  ${text(
    formatCoverageSummary(candidate),
    "dim",
  )}  ${text(reasonSummary, "muted")}`;
}

function appendSection(
  lines: string[],
  anchors: Partial<Record<TuiDetailSection, number>>,
  foldedSections: TuiDetailFoldState,
  section: TuiDetailSection,
  title: string,
  body: string[],
  options: { foldable?: boolean } = {},
): void {
  if (lines.length > 0) {
    lines.push("");
  }
  anchors[section] = lines.length;
  const collapsed = options.foldable && foldedSections[section] === true;
  lines.push(
    collapsed ? `${sectionLabel(title)} ${text("[collapsed]", "muted")}` : sectionLabel(title),
  );
  if (collapsed) {
    return;
  }
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
  foldedSections: TuiDetailFoldState = {},
): { lines: string[]; anchorLine: number | null } {
  const lines = formatPrioritySummary(bundle.candidate);
  const anchors: Partial<Record<TuiDetailSection, number>> = {};
  appendSection(lines, anchors, foldedSections, "summary", "Summary", [
    truncate(bundle.candidate.pr.matchedExcerpt, 520),
  ]);
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(sectionLabel("Why Prioritized"));
  lines.push(...formatReasonLines(bundle.candidate.reasons));
  appendSection(
    lines,
    anchors,
    foldedSections,
    "linked-issues",
    "Linked Issues",
    [
      `${text("count", "muted")} ${bundle.linkedIssues.length}`,
      ...(bundle.linkedIssues.length > 0
        ? bundle.linkedIssues.map((issue) => `- #${issue.issueNumber} ${issue.title}`)
        : ["(none)"]),
    ],
    { foldable: true },
  );
  appendSection(
    lines,
    anchors,
    foldedSections,
    "related-prs",
    "Related PRs",
    [
      `${text("count", "muted")} ${bundle.relatedPullRequests.length}`,
      ...(bundle.relatedPullRequests.length > 0
        ? bundle.relatedPullRequests.map((pr) => `- #${pr.prNumber} ${pr.title}`)
        : ["(none)"]),
    ],
    { foldable: true },
  );
  const bestBase = bundle.cluster?.bestBase ?? null;
  const sameClusterCandidates = bundle.cluster?.sameClusterCandidates ?? [];
  const nearbyButExcluded = bundle.cluster?.nearbyButExcluded ?? [];
  const clusterCandidates =
    (bestBase ? 1 : 0) + sameClusterCandidates.length + nearbyButExcluded.length;
  appendSection(
    lines,
    anchors,
    foldedSections,
    "cluster",
    "Cluster",
    [
      bundle.cluster
        ? `${text("basis", "muted")} ${bundle.cluster.clusterBasis}`
        : `${text("basis", "muted")} (none)`,
      bundle.cluster && bundle.cluster.clusterIssueNumbers.length > 0
        ? `${text("issues", "muted")} ${bundle.cluster.clusterIssueNumbers.map((issue) => `#${issue}`).join(", ")}`
        : `${text("issues", "muted")} (none)`,
      `${text("rows", "muted")} ${clusterCandidates}`,
      ...(bestBase ? [formatClusterCandidateLine(bestBase, "★", "best base")] : []),
      ...(sameClusterCandidates.length > 0
        ? sameClusterCandidates
            .filter((candidate) => candidate.prNumber !== bestBase?.prNumber)
            .map((candidate) =>
              formatClusterCandidateLine(
                candidate,
                candidate.status === "superseded_candidate" ? "└" : "├",
                candidate.status.replaceAll("_", " "),
              ),
            )
        : bestBase
          ? []
          : ["(none)"]),
      ...(nearbyButExcluded.length > 0
        ? [
            `${text("excluded", "muted")} +${nearbyButExcluded.length} candidate${
              nearbyButExcluded.length === 1 ? "" : "s"
            } hidden  ${text("[e to show]", "dim")}`,
          ]
        : []),
    ],
    { foldable: true },
  );
  appendSection(
    lines,
    anchors,
    foldedSections,
    "maintainer-state",
    "Maintainer State",
    [
      `${text("attention", "muted")} ${bundle.candidate.attentionState}`,
      `${text("watchlist", "muted")} ${bundle.candidate.attentionState === "watch" ? "yes" : "no"}`,
      `${text("ignore", "muted")} ${bundle.candidate.attentionState === "ignore" ? "yes" : "no"}`,
    ],
    { foldable: true },
  );
  if (bundle.comments.length > 0 || bundle.latestReviewFact || bundle.mergeReadiness) {
    const sparseExtras: string[] = [];
    if (bundle.comments.length > 0) {
      sparseExtras.push(`${text("recent_comments", "muted")} ${bundle.comments.length}`);
      for (const comment of bundle.comments) {
        sparseExtras.push(
          `- [${comment.kind}] ${comment.author}: ${truncate(comment.excerpt, 120)}`,
        );
      }
    }
    if (bundle.latestReviewFact) {
      sparseExtras.push(
        `${text("latest_review_fact", "muted")} ${bundle.latestReviewFact.decision} · ${bundle.latestReviewFact.summary}`,
      );
    }
    if (bundle.mergeReadiness) {
      sparseExtras.push(
        `${text("merge_readiness", "muted")} ${bundle.mergeReadiness.state} via ${bundle.mergeReadiness.source}`,
      );
      sparseExtras.push(`  ${truncate(bundle.mergeReadiness.summary, 160)}`);
    }
    appendSection(lines, anchors, foldedSections, "sparse-extras", "Sparse Extras", sparseExtras, {
      foldable: true,
    });
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
    "Inbox collapses overlapping PR work so you can review clusters before individual PRs.",
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
    "1 Review the collapsed priority queue.",
    "2 Press Enter to open the selected PR or cluster investigation workspace.",
    "3 Press e to expand a collapsed cluster into member PRs.",
    "4 Press x or c to jump to linked issues or cluster.",
    "5 Press v / w / i / u to manage local triage state.",
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
  foldedSections: TuiDetailFoldState;
}): TuiDetailPaneModel {
  const { payload, visible, status, identity, anchorKey, focusSection, foldedSections } = input;
  switch (payload.kind) {
    case "pr": {
      const formatted = formatPriorityPrDetail(payload.bundle, focusSection, foldedSections);
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
    case "cluster":
      return {
        visible,
        title: `Cluster · #${payload.candidate.prNumber}`,
        status,
        lines: formatClusterDetail(payload.analysis, payload.candidate),
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
