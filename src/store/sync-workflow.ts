import { runTasksWithConcurrency } from "../lib/concurrency.js";
import { isoNow } from "../lib/time.js";
import { selectPullRequestSyncWriteTarget } from "./pull-request-sync-contract.js";
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

export type PullRequestSyncWorkflowResult = {
  summary: SyncSummary;
  touchedPrNumbers: number[];
};

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
  upsertPullRequestSummary: (pr: PullRequestRecord, authority: "authoritative" | "partial") => void;
  setMeta: (key: string, value: string) => void;
  countRows: (table: string) => number;
  metaKeys: {
    repo: string;
    lastSyncAt: string;
    lastSyncWatermark: string;
  };
}): Promise<PullRequestSyncWorkflowResult> {
  const mode = params.full || !params.lastSyncWatermark ? "full" : "incremental";
  const syncStartedAt = isoNow();
  params.setMeta(params.metaKeys.repo, params.repoName);

  const toProcess: number[] = [];
  const summaryPullRequests: PullRequestRecord[] = [];
  const touchedPrNumbers = new Set<number>();
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
      queued: Math.max(0, summaryPullRequests.length + toProcess.length - processedPrs),
      totalKnown: mode === "incremental" ? summaryPullRequests.length + toProcess.length : null,
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
      const target = selectPullRequestSyncWriteTarget({
        pr,
        mode,
        hydrateAll: params.hydrateAll,
        storedUpdatedAt: existingUpdatedAt,
      });
      if (target.kind === "hydrate") {
        toProcess.push(target.prNumber);
        touchedPrNumbers.add(target.prNumber);
      } else {
        summaryPullRequests.push(target.pr);
        touchedPrNumbers.add(target.pr.number);
      }
    }
  } else if (params.lastSyncWatermark) {
    if (params.source.listChangedPullRequestsSince) {
      for (const pr of await params.source.listChangedPullRequestsSince(
        params.repo,
        params.lastSyncWatermark,
      )) {
        const target = selectPullRequestSyncWriteTarget({
          pr,
          mode,
          hydrateAll: params.hydrateAll,
          storedUpdatedAt: params.getStoredUpdatedAt(pr.number),
        });
        if (target.kind === "hydrate") {
          toProcess.push(target.prNumber);
          touchedPrNumbers.add(target.prNumber);
          continue;
        }
        summaryPullRequests.push(target.pr);
        touchedPrNumbers.add(target.pr.number);
      }
    } else {
      const changedNumbers = await params.source.listChangedPullRequestNumbersSince(
        params.repo,
        params.lastSyncWatermark,
      );
      for (const prNumber of changedNumbers) {
        toProcess.push(prNumber);
        touchedPrNumbers.add(prNumber);
      }
    }
  }

  for (const pr of summaryPullRequests) {
    params.upsertPullRequestSummary(pr, mode === "full" ? "authoritative" : "partial");
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
  params.setMeta(params.metaKeys.lastSyncWatermark, syncStartedAt);
  emitProgress("complete");

  return {
    summary: {
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
      lastSyncWatermark: syncStartedAt,
    },
    touchedPrNumbers: Array.from(touchedPrNumbers).sort((a, b) => a - b),
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
  const syncStartedAt = isoNow();
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
  params.setMeta(params.metaKeys.lastSyncWatermark, syncStartedAt);
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
    lastSyncWatermark: syncStartedAt,
  };
}
