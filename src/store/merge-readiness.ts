import type {
  ClusterCandidate,
  MergeReadiness,
  PullRequestFactRecord,
  PullRequestReviewFact,
} from "../types.js";

const FAILING_CHECK_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "CANCELLED",
]);

function dedupeCheckNames(names: string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([name, count]) => (count > 1 ? `${name} (x${count})` : name));
}

export function resolveMergeReadiness(params: {
  candidate: ClusterCandidate | null;
  latestReviewFact: PullRequestReviewFact | null;
  githubSnapshot: {
    reviewDecision: string | null;
    mergeStateStatus: string | null;
    mergeable: string | null;
    statusChecks: PullRequestFactRecord["statusChecks"];
  } | null;
}): MergeReadiness | null {
  const { candidate, latestReviewFact, githubSnapshot } = params;
  if (!candidate) {
    return null;
  }
  if (candidate.state !== "open") {
    return {
      state: "historical",
      source: "github",
      summary: "Pull request is not open.",
      failingChecks: [],
      pendingChecks: [],
      headSha: candidate.headSha,
      staleReviewFact:
        latestReviewFact && candidate.headSha && latestReviewFact.headSha !== candidate.headSha
          ? {
              headSha: latestReviewFact.headSha,
              decision: latestReviewFact.decision,
              recordedAt: latestReviewFact.recordedAt,
            }
          : undefined,
    };
  }
  if (latestReviewFact && candidate.headSha && latestReviewFact.headSha === candidate.headSha) {
    return {
      state: latestReviewFact.decision,
      source: "review_fact",
      summary: latestReviewFact.summary,
      failingTests: latestReviewFact.failingTests,
      commands: latestReviewFact.commands,
      headSha: latestReviewFact.headSha,
    };
  }
  if (!githubSnapshot) {
    return {
      state: "unknown",
      source: "github",
      summary: "No GitHub fact snapshot recorded for this pull request.",
      failingChecks: [],
      pendingChecks: [],
      headSha: candidate.headSha,
    };
  }

  const failingChecks = dedupeCheckNames(
    githubSnapshot.statusChecks
      .filter((check) => check.conclusion && FAILING_CHECK_CONCLUSIONS.has(check.conclusion))
      .map((check) => check.name),
  );
  const pendingChecks = dedupeCheckNames(
    githubSnapshot.statusChecks
      .filter((check) => check.status !== "COMPLETED")
      .map((check) => check.name),
  );

  let state: MergeReadiness["state"] = "ready";
  let summary = "GitHub review decision and checks are green.";
  if (githubSnapshot.reviewDecision === "CHANGES_REQUESTED") {
    state = "needs_work";
    summary = "GitHub review decision is CHANGES_REQUESTED.";
  } else if (githubSnapshot.reviewDecision === "REVIEW_REQUIRED") {
    state = "pending";
    summary = "GitHub review is still required before merge.";
  } else if (failingChecks.length > 0) {
    state = "needs_work";
    summary = "One or more GitHub checks are failing.";
  } else if (
    githubSnapshot.mergeable === "CONFLICTING" ||
    githubSnapshot.mergeStateStatus === "DIRTY" ||
    githubSnapshot.mergeStateStatus === "BLOCKED"
  ) {
    state = "needs_work";
    summary = "GitHub reports the pull request is blocked or conflicting.";
  } else if (pendingChecks.length > 0) {
    state = "pending";
    summary = "GitHub checks are still pending.";
  }

  return {
    state,
    source: "github",
    summary,
    failingChecks,
    pendingChecks,
    headSha: candidate.headSha,
    staleReviewFact:
      latestReviewFact && candidate.headSha && latestReviewFact.headSha !== candidate.headSha
        ? {
            headSha: latestReviewFact.headSha,
            decision: latestReviewFact.decision,
            recordedAt: latestReviewFact.recordedAt,
          }
        : undefined,
  };
}
