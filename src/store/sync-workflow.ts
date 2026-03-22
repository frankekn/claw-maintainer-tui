import { runTasksWithConcurrency } from "../lib/concurrency.js";
import { isoNow } from "../lib/time.js";
import type {
  HydratedPullRequest,
  IssueDataSource,
  IssueRecord,
  PullRequestDataSource,
  PullRequestRecord,
  RepoRef,
  SyncProgressEvent,
  SyncSummary,
} from "../types.js";

export async function syncPullRequestsWorkflow(params: {
  repo: RepoRef;
  source: PullRequestDataSource;
  full?: boolean;
  hydrateAll?: boolean;
  onProgress?: (event: SyncProgressEvent) => void;
  syncConcurrency: number;
  lastSyncWatermark: string | null;
  repoName: string;
  vectorAvailable: boolean;
  getStoredUpdatedAt: (prNumber: number) => string | null;
  upsertHydratedPullRequest: (
    payload: HydratedPullRequest,
    options: { indexVectors: boolean },
  ) => Promise<void>;
  upsertPullRequestSummary: (pr: PullRequestRecord) => void;
  setMeta: (key: string, value: string) => void;
  countRows: (table: string) => number;
  metaKeys: {
    repo: string;
    lastSyncAt: string;
    lastSyncWatermark: string;
  };
}): Promise<SyncSummary> {
  const mode = params.full || !params.lastSyncWatermark ? "full" : "incremental";
  params.setMeta(params.metaKeys.repo, params.repoName);

  const toProcess: number[] = [];
  const shallowPullRequests: HydratedPullRequest[] = [];
  const summaryPullRequests: PullRequestRecord[] = [];
  let skippedPrs = 0;
  let processedPrs = 0;
  const emitProgress = (
    phase: SyncProgressEvent["phase"],
    currentId: number | null = null,
    currentTitle: string | null = null,
  ) => {
    params.onProgress?.({
      entity: "prs",
      phase,
      processed: processedPrs,
      skipped: skippedPrs,
      queued: Math.max(
        0,
        shallowPullRequests.length + summaryPullRequests.length + toProcess.length - processedPrs,
      ),
      totalKnown:
        mode === "incremental"
          ? shallowPullRequests.length + summaryPullRequests.length + toProcess.length
          : null,
      currentId,
      currentTitle,
    });
  };

  if (mode === "full") {
    for await (const pr of params.source.listAllPullRequests(params.repo)) {
      emitProgress("discovering", pr.number, pr.title);
      const existingUpdatedAt = params.getStoredUpdatedAt(pr.number);
      if (existingUpdatedAt === pr.updatedAt) {
        skippedPrs += 1;
        emitProgress("discovering", pr.number, pr.title);
        continue;
      }
      if (params.hydrateAll) {
        toProcess.push(pr.number);
      } else {
        shallowPullRequests.push({ pr, comments: [] });
      }
    }
  } else if (params.lastSyncWatermark) {
    if (params.source.listChangedPullRequestsSince) {
      for (const pr of await params.source.listChangedPullRequestsSince(
        params.repo,
        params.lastSyncWatermark,
      )) {
        // First-seen PRs cannot safely use issue-style summaries because draft and
        // branch metadata are missing from that payload.
        if (!params.getStoredUpdatedAt(pr.number)) {
          toProcess.push(pr.number);
          continue;
        }
        // Some sources only return issue-style summaries for changed PRs, which cannot
        // reliably distinguish merged from closed. Hydrate those ambiguous closed PRs
        // before overwriting the stored record.
        if (pr.state === "closed" && !pr.mergedAt) {
          toProcess.push(pr.number);
          continue;
        }
        summaryPullRequests.push(pr);
      }
    } else {
      toProcess.push(
        ...(await params.source.listChangedPullRequestNumbersSince(
          params.repo,
          params.lastSyncWatermark,
        )),
      );
    }
  }

  for (const payload of shallowPullRequests) {
    await params.upsertHydratedPullRequest(payload, { indexVectors: false });
    processedPrs += 1;
    emitProgress("syncing", payload.pr.number, payload.pr.title);
  }
  for (const pr of summaryPullRequests) {
    params.upsertPullRequestSummary(pr);
    processedPrs += 1;
    emitProgress("syncing", pr.number, pr.title);
  }

  const result = await runTasksWithConcurrency({
    tasks: toProcess.map((prNumber) => async () => {
      const hydrated = await params.source.hydratePullRequest(params.repo, prNumber);
      await params.upsertHydratedPullRequest(hydrated, { indexVectors: false });
      processedPrs += 1;
      emitProgress("syncing", hydrated.pr.number, hydrated.pr.title);
      return prNumber;
    }),
    limit: params.syncConcurrency,
    errorMode: "stop",
  });
  if (result.hasError) {
    throw result.firstError;
  }

  const syncedAt = isoNow();
  params.setMeta(params.metaKeys.lastSyncAt, syncedAt);
  params.setMeta(params.metaKeys.lastSyncWatermark, syncedAt);
  emitProgress("complete");

  return {
    mode,
    entity: "prs",
    repo: params.repoName,
    processedPrs,
    processedIssues: 0,
    skippedPrs,
    skippedIssues: 0,
    docCount: params.countRows("search_docs"),
    commentCount: params.countRows("pr_comments"),
    labelCount: params.countRows("pr_labels"),
    vectorAvailable: params.vectorAvailable,
    lastSyncAt: syncedAt,
    lastSyncWatermark: syncedAt,
  };
}

export async function syncIssuesWorkflow(params: {
  repo: RepoRef;
  source: IssueDataSource;
  full?: boolean;
  onProgress?: (event: SyncProgressEvent) => void;
  syncConcurrency: number;
  lastSyncWatermark: string | null;
  repoName: string;
  vectorAvailable: boolean;
  getStoredIssueUpdatedAt: (issueNumber: number) => string | null;
  upsertIssue: (issue: IssueRecord) => void;
  setMeta: (key: string, value: string) => void;
  countRows: (table: string) => number;
  metaKeys: {
    repo: string;
    lastSyncAt: string;
    lastSyncWatermark: string;
  };
}): Promise<SyncSummary> {
  const mode = params.full || !params.lastSyncWatermark ? "full" : "incremental";
  params.setMeta(params.metaKeys.repo, params.repoName);

  const toProcess: number[] = [];
  const shallowIssues: IssueRecord[] = [];
  let skippedIssues = 0;
  let processedIssues = 0;
  const emitProgress = (
    phase: SyncProgressEvent["phase"],
    currentId: number | null = null,
    currentTitle: string | null = null,
  ) => {
    params.onProgress?.({
      entity: "issues",
      phase,
      processed: processedIssues,
      skipped: skippedIssues,
      queued: Math.max(0, shallowIssues.length + toProcess.length - processedIssues),
      totalKnown: mode === "incremental" ? shallowIssues.length + toProcess.length : null,
      currentId,
      currentTitle,
    });
  };

  if (mode === "full") {
    for await (const issue of params.source.listAllIssues(params.repo)) {
      emitProgress("discovering", issue.number, issue.title);
      const existingUpdatedAt = params.getStoredIssueUpdatedAt(issue.number);
      if (existingUpdatedAt === issue.updatedAt) {
        skippedIssues += 1;
        emitProgress("discovering", issue.number, issue.title);
        continue;
      }
      shallowIssues.push(issue);
    }
  } else if (params.lastSyncWatermark) {
    if (params.source.listChangedIssuesSince) {
      shallowIssues.push(
        ...(await params.source.listChangedIssuesSince(params.repo, params.lastSyncWatermark)),
      );
    } else {
      toProcess.push(
        ...(await params.source.listChangedIssueNumbersSince(
          params.repo,
          params.lastSyncWatermark,
        )),
      );
    }
  }

  for (const issue of shallowIssues) {
    params.upsertIssue(issue);
    processedIssues += 1;
    emitProgress("syncing", issue.number, issue.title);
  }

  const result = await runTasksWithConcurrency({
    tasks: toProcess.map((issueNumber) => async () => {
      const issue = await params.source.getIssue(params.repo, issueNumber);
      params.upsertIssue(issue);
      processedIssues += 1;
      emitProgress("syncing", issue.number, issue.title);
      return issueNumber;
    }),
    limit: params.syncConcurrency,
    errorMode: "stop",
  });
  if (result.hasError) {
    throw result.firstError;
  }

  const syncedAt = isoNow();
  params.setMeta(params.metaKeys.lastSyncAt, syncedAt);
  params.setMeta(params.metaKeys.lastSyncWatermark, syncedAt);
  emitProgress("complete");

  return {
    mode,
    entity: "issues",
    repo: params.repoName,
    processedPrs: 0,
    processedIssues,
    skippedPrs: 0,
    skippedIssues,
    docCount: params.countRows("search_docs"),
    commentCount: params.countRows("pr_comments"),
    labelCount: params.countRows("issue_labels"),
    vectorAvailable: params.vectorAvailable,
    lastSyncAt: syncedAt,
    lastSyncWatermark: syncedAt,
  };
}
