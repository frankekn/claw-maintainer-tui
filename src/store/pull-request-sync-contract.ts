import type { PullRequestRecord } from "../types.js";

export type PullRequestSummaryAuthority = "authoritative" | "partial";

export type PullRequestStoredSummaryFields = {
  state: PullRequestRecord["state"];
  isDraft: boolean;
  baseRef: string;
  headRef: string;
  url: string;
  closedAt: string | null;
  mergedAt: string | null;
};

export type PullRequestSyncWriteTarget =
  | {
      kind: "summary";
      authority: PullRequestSummaryAuthority;
      pr: PullRequestRecord;
    }
  | {
      kind: "hydrate";
      prNumber: number;
    };

export function requiresHydratedIncrementalRefresh(pr: PullRequestRecord): boolean {
  return !pr.baseRef || !pr.headRef || (pr.state === "closed" && !pr.mergedAt);
}

export function selectPullRequestSyncWriteTarget(params: {
  pr: PullRequestRecord;
  mode: "full" | "incremental";
  hydrateAll?: boolean;
  storedUpdatedAt: string | null;
}): PullRequestSyncWriteTarget {
  if (params.hydrateAll) {
    return {
      kind: "hydrate",
      prNumber: params.pr.number,
    };
  }
  if (params.mode === "full") {
    return {
      kind: "summary",
      authority: "authoritative",
      pr: params.pr,
    };
  }
  if (!params.storedUpdatedAt || requiresHydratedIncrementalRefresh(params.pr)) {
    return {
      kind: "hydrate",
      prNumber: params.pr.number,
    };
  }
  return {
    kind: "summary",
    authority: "partial",
    pr: params.pr,
  };
}

export function mergeSummaryPullRequestRecord(params: {
  pr: PullRequestRecord;
  authority: PullRequestSummaryAuthority;
  existing: PullRequestStoredSummaryFields | null;
}): PullRequestRecord {
  const { authority, existing, pr } = params;
  const authoritative = authority === "authoritative";
  const baseRef = pr.baseRef || existing?.baseRef || "";
  const headRef = pr.headRef || existing?.headRef || "";
  return {
    ...pr,
    state:
      authority === "partial" && pr.state === "closed" && existing?.state === "merged"
        ? "merged"
        : pr.state,
    isDraft: authoritative ? pr.isDraft : (existing?.isDraft ?? pr.isDraft),
    baseRef,
    headRef,
    url: pr.url || existing?.url || "",
    closedAt: authoritative ? pr.closedAt : (pr.closedAt ?? existing?.closedAt ?? null),
    mergedAt: authoritative ? pr.mergedAt : (pr.mergedAt ?? existing?.mergedAt ?? null),
  };
}
