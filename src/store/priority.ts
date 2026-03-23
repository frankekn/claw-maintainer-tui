import type {
  PriorityAttentionState,
  PriorityCandidate,
  PriorityReason,
  SearchResult,
} from "../types.js";

export function freshnessReason(updatedAt: string, now = Date.now()): PriorityReason | null {
  const ageMs = now - new Date(updatedAt).getTime();
  if (ageMs < 24 * 60 * 60 * 1000) {
    return { type: "freshness", label: "updated in the last 24h", points: 10 };
  }
  if (ageMs < 72 * 60 * 60 * 1000) {
    return { type: "freshness", label: "updated in the last 72h", points: 6 };
  }
  if (ageMs < 7 * 24 * 60 * 60 * 1000) {
    return { type: "freshness", label: "updated in the last 7d", points: 3 };
  }
  return null;
}

export function buildPriorityCandidateBase(params: {
  pr: SearchResult;
  attentionState: PriorityAttentionState;
  labels: string[];
  isDraft: boolean;
}): PriorityCandidate {
  const reasons: PriorityReason[] = [];
  let score = 0;

  if (params.attentionState === "watch") {
    reasons.push({ type: "watch", label: "watchlist pin", points: 30 });
    score += 30;
  }
  const freshness = freshnessReason(params.pr.updatedAt);
  if (freshness) {
    reasons.push(freshness);
    score += freshness.points;
  }
  if (reasons.length === 0) {
    reasons.push({ type: "freshness", label: "open PR fallback", points: 0 });
  }
  if (params.isDraft) {
    score -= 6;
  }

  return {
    pr: {
      ...params.pr,
      score,
    },
    attentionState: params.attentionState,
    score,
    reasons,
    linkedIssueCount: 0,
    relatedPullRequestCount: 0,
    badges: {
      draft: params.isDraft,
      maintainer: params.labels.includes("maintainer"),
    },
  };
}

export function enrichPriorityCandidate(params: {
  candidate: PriorityCandidate;
  linkedIssueCount: number;
  relatedPullRequestCount: number;
}): PriorityCandidate {
  const { candidate, linkedIssueCount, relatedPullRequestCount } = params;
  const reasons = [...candidate.reasons];
  let score = candidate.score;

  if (linkedIssueCount > 0) {
    const points = Math.min(24, 12 + Math.max(0, linkedIssueCount - 1) * 4);
    reasons.push({
      type: "linked_issue",
      label: `links ${linkedIssueCount} issue${linkedIssueCount === 1 ? "" : "s"}`,
      points,
    });
    score += points;
  }
  if (relatedPullRequestCount > 0) {
    const points = Math.min(16, 10 + Math.max(0, relatedPullRequestCount - 1) * 3);
    reasons.push({
      type: "related_pr",
      label: `connects to ${relatedPullRequestCount} related PR${relatedPullRequestCount === 1 ? "" : "s"}`,
      points,
    });
    score += points;
  }
  if (linkedIssueCount > 0 && relatedPullRequestCount > 0) {
    reasons.push({
      type: "hub_bonus",
      label: "connects issues and related PR work",
      points: 8,
    });
    score += 8;
  }

  return {
    ...candidate,
    pr: {
      ...candidate.pr,
      score,
    },
    score,
    reasons: reasons
      .slice()
      .sort((left, right) => right.points - left.points || left.label.localeCompare(right.label)),
    linkedIssueCount,
    relatedPullRequestCount,
  };
}
