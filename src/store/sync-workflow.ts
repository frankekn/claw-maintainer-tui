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

export const HOT_PR_LIMIT = 500;
export const HOT_ISSUE_LIMIT = 500;
export const BACKFILL_PAGES_PER_SLICE = 2;
export const PAGE_SIZE = 100;
// Hot issue sync uses issue-only search pages, so a small page budget can still
// collect up to HOT_ISSUE_LIMIT real issues without scanning PR-heavy /issues pages.
export const HOT_ISSUE_SCAN_PAGE_BUDGET = Math.ceil(HOT_ISSUE_LIMIT / PAGE_SIZE);

export type PullRequestSyncWorkflowResult = {
  summary: SyncSummary;
  touchedPrNumbers: number[];
};

export async function syncPullRequestsWorkflow(params: {
  repo: RepoRef;
  source: PullRequestDataSource;
  full?: boolean;
  hydrateAll?: boolean;
  maxFullSyncItems?: number;
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
    for await (const pr of params.source.listAllPullRequests(params.repo, {
      limit: params.maxFullSyncItems,
      newestFirst: params.maxFullSyncItems !== undefined,
    })) {
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
  maxFullSyncItems?: number;
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
    for await (const issue of params.source.listAllIssues(params.repo, {
      limit: params.maxFullSyncItems,
      newestFirst: params.maxFullSyncItems !== undefined,
    })) {
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

export async function syncHotPullRequestsWorkflow(params: {
  repo: RepoRef;
  source: PullRequestDataSource;
  onProgress?: (event: SyncProgressEvent) => void;
  repoName: string;
  vectorAvailable: boolean;
  upsertPullRequestSummary: (pr: PullRequestRecord, authority: "authoritative" | "partial") => void;
  setMeta: (key: string, value: string) => void;
  countRows: (table: string) => number;
  existingLastSyncWatermark: string | null;
  metaKeys: {
    repo: string;
    hotSyncAt: string;
    lastSyncAt: string;
  };
}): Promise<SyncSummary> {
  const hotSyncAt = isoNow();
  params.setMeta(params.metaKeys.repo, params.repoName);

  let processedPrs = 0;
  const skippedPrs = 0;
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
      queued: 0,
      totalKnown: null,
      currentId,
      currentTitle,
    });
  };

  for await (const pr of params.source.listAllPullRequests(params.repo, {
    sort: "updated",
    direction: "desc",
    limit: HOT_PR_LIMIT,
  })) {
    emitProgress("syncing", pr.number, pr.title);
    params.upsertPullRequestSummary(pr, "partial");
    processedPrs += 1;
    emitProgress("syncing", pr.number, pr.title);
  }

  params.setMeta(params.metaKeys.hotSyncAt, hotSyncAt);
  params.setMeta(params.metaKeys.lastSyncAt, hotSyncAt);
  emitProgress("complete");

  return {
    mode: "hot",
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
    lastSyncAt: hotSyncAt,
    lastSyncWatermark: params.existingLastSyncWatermark,
  };
}

export async function syncHotIssuesWorkflow(params: {
  repo: RepoRef;
  source: IssueDataSource;
  onProgress?: (event: SyncProgressEvent) => void;
  repoName: string;
  vectorAvailable: boolean;
  upsertIssue: (issue: IssueRecord) => void;
  setMeta: (key: string, value: string) => void;
  countRows: (table: string) => number;
  existingLastSyncWatermark: string | null;
  metaKeys: {
    repo: string;
    hotSyncAt: string;
    lastSyncAt: string;
  };
}): Promise<SyncSummary> {
  const hotSyncAt = isoNow();
  params.setMeta(params.metaKeys.repo, params.repoName);

  let processedIssues = 0;
  const skippedIssues = 0;
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
      queued: 0,
      totalKnown: null,
      currentId,
      currentTitle,
    });
  };

  const processIssue = (issue: IssueRecord): void => {
    emitProgress("syncing", issue.number, issue.title);
    params.upsertIssue(issue);
    processedIssues += 1;
    emitProgress("syncing", issue.number, issue.title);
  };

  if (params.source.listIssuePages) {
    for await (const page of params.source.listIssuePages(params.repo, {
      sort: "updated",
      direction: "desc",
      pageLimit: HOT_ISSUE_SCAN_PAGE_BUDGET,
    })) {
      for (const issue of page.issues) {
        if (processedIssues >= HOT_ISSUE_LIMIT) {
          break;
        }
        processIssue(issue);
      }
      if (processedIssues >= HOT_ISSUE_LIMIT) {
        break;
      }
    }
  } else {
    for await (const issue of params.source.listAllIssues(params.repo, {
      sort: "updated",
      direction: "desc",
      limit: HOT_ISSUE_LIMIT,
    })) {
      processIssue(issue);
    }
  }

  params.setMeta(params.metaKeys.hotSyncAt, hotSyncAt);
  params.setMeta(params.metaKeys.lastSyncAt, hotSyncAt);
  emitProgress("complete");

  return {
    mode: "hot",
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
    lastSyncAt: hotSyncAt,
    lastSyncWatermark: params.existingLastSyncWatermark,
  };
}

export async function backfillPullRequestsWorkflow(params: {
  repo: RepoRef;
  source: PullRequestDataSource;
  onProgress?: (event: SyncProgressEvent) => void;
  repoName: string;
  vectorAvailable: boolean;
  upsertPullRequestSummary: (pr: PullRequestRecord, authority: "authoritative" | "partial") => void;
  setMeta: (key: string, value: string) => void;
  countRows: (table: string) => number;
  cursor: number | null;
  completedAt: string | null;
  metaKeys: {
    repo: string;
    backfillCursor: string;
    backfillCompletedAt: string;
  };
}): Promise<SyncSummary> {
  if (params.completedAt) {
    return {
      mode: "backfill",
      entity: "prs",
      repo: params.repoName,
      processedPrs: 0,
      processedIssues: 0,
      skippedPrs: 0,
      skippedIssues: 0,
      docCount: params.countRows("search_docs"),
      commentCount: params.countRows("pr_comments"),
      labelCount: params.countRows("pr_labels"),
      vectorAvailable: params.vectorAvailable,
      lastSyncAt: null,
      lastSyncWatermark: null,
      reason: "backfill_complete",
      nextBackfillCursor: null,
    };
  }
  params.setMeta(params.metaKeys.repo, params.repoName);

  const startCursor = Math.max(1, params.cursor ?? 1);
  let cursor = startCursor;
  let processedPrs = 0;
  let itemsInCurrentPage = 0;
  let lastPageWasPartial = false;

  const emitProgress = (
    phase: SyncProgressEvent["phase"],
    currentId: number | null = null,
    currentTitle: string | null = null,
  ) => {
    params.onProgress?.({
      entity: "prs",
      phase,
      processed: processedPrs,
      skipped: 0,
      queued: 0,
      totalKnown: null,
      currentId,
      currentTitle,
    });
  };

  const limit = BACKFILL_PAGES_PER_SLICE * PAGE_SIZE;
  let yielded = 0;
  for await (const pr of params.source.listAllPullRequests(params.repo, {
    sort: "created",
    direction: "asc",
    startPage: cursor,
    limit,
  })) {
    emitProgress("syncing", pr.number, pr.title);
    params.upsertPullRequestSummary(pr, "partial");
    processedPrs += 1;
    yielded += 1;
    itemsInCurrentPage += 1;
    if (itemsInCurrentPage >= PAGE_SIZE) {
      cursor += 1;
      params.setMeta(params.metaKeys.backfillCursor, String(cursor));
      itemsInCurrentPage = 0;
    }
    emitProgress("syncing", pr.number, pr.title);
  }

  // If the last page (or only page) returned a partial result, the data source has been exhausted.
  if (itemsInCurrentPage > 0) {
    lastPageWasPartial = true;
    cursor += 1;
    params.setMeta(params.metaKeys.backfillCursor, String(cursor));
  } else if (yielded < limit) {
    // We may have yielded an exact page boundary but no further pages exist.
    lastPageWasPartial = true;
  }

  let nextBackfillCursor: number | null = cursor;
  if (lastPageWasPartial) {
    const completedAt = isoNow();
    params.setMeta(params.metaKeys.backfillCompletedAt, completedAt);
    nextBackfillCursor = null;
  }

  emitProgress("complete");

  return {
    mode: "backfill",
    entity: "prs",
    repo: params.repoName,
    processedPrs,
    processedIssues: 0,
    skippedPrs: 0,
    skippedIssues: 0,
    docCount: params.countRows("search_docs"),
    commentCount: params.countRows("pr_comments"),
    labelCount: params.countRows("pr_labels"),
    vectorAvailable: params.vectorAvailable,
    lastSyncAt: null,
    lastSyncWatermark: null,
    nextBackfillCursor,
  };
}

export async function backfillIssuesWorkflow(params: {
  repo: RepoRef;
  source: IssueDataSource;
  onProgress?: (event: SyncProgressEvent) => void;
  repoName: string;
  vectorAvailable: boolean;
  upsertIssue: (issue: IssueRecord) => void;
  setMeta: (key: string, value: string) => void;
  countRows: (table: string) => number;
  cursor: number | null;
  completedAt: string | null;
  metaKeys: {
    repo: string;
    backfillCursor: string;
    backfillCompletedAt: string;
  };
}): Promise<SyncSummary> {
  if (params.completedAt) {
    return {
      mode: "backfill",
      entity: "issues",
      repo: params.repoName,
      processedPrs: 0,
      processedIssues: 0,
      skippedPrs: 0,
      skippedIssues: 0,
      docCount: params.countRows("search_docs"),
      commentCount: params.countRows("pr_comments"),
      labelCount: params.countRows("issue_labels"),
      vectorAvailable: params.vectorAvailable,
      lastSyncAt: null,
      lastSyncWatermark: null,
      reason: "backfill_complete",
      nextBackfillCursor: null,
    };
  }
  params.setMeta(params.metaKeys.repo, params.repoName);

  const startCursor = Math.max(1, params.cursor ?? 1);
  let cursor = startCursor;
  let processedIssues = 0;
  let itemsInCurrentPage = 0;
  let lastPageWasPartial = false;

  const emitProgress = (
    phase: SyncProgressEvent["phase"],
    currentId: number | null = null,
    currentTitle: string | null = null,
  ) => {
    params.onProgress?.({
      entity: "issues",
      phase,
      processed: processedIssues,
      skipped: 0,
      queued: 0,
      totalKnown: null,
      currentId,
      currentTitle,
    });
  };

  const processIssue = (issue: IssueRecord): void => {
    emitProgress("syncing", issue.number, issue.title);
    params.upsertIssue(issue);
    processedIssues += 1;
    emitProgress("syncing", issue.number, issue.title);
  };

  const limit = BACKFILL_PAGES_PER_SLICE * PAGE_SIZE;
  if (params.source.listIssuePages) {
    let fetchedPages = 0;
    for await (const page of params.source.listIssuePages(params.repo, {
      sort: "created",
      direction: "asc",
      startPage: cursor,
      pageLimit: BACKFILL_PAGES_PER_SLICE,
    })) {
      fetchedPages += 1;
      for (const issue of page.issues) {
        processIssue(issue);
      }
      cursor = Math.max(cursor + 1, page.page + 1);
      params.setMeta(params.metaKeys.backfillCursor, String(cursor));
      if (page.fetchedItemCount < PAGE_SIZE) {
        lastPageWasPartial = true;
        break;
      }
    }
    if (fetchedPages < BACKFILL_PAGES_PER_SLICE) {
      lastPageWasPartial = true;
    }
  } else {
    let yielded = 0;
    for await (const issue of params.source.listAllIssues(params.repo, {
      sort: "created",
      direction: "asc",
      startPage: cursor,
      limit,
    })) {
      processIssue(issue);
      yielded += 1;
      itemsInCurrentPage += 1;
      if (itemsInCurrentPage >= PAGE_SIZE) {
        cursor += 1;
        params.setMeta(params.metaKeys.backfillCursor, String(cursor));
        itemsInCurrentPage = 0;
      }
    }

    if (itemsInCurrentPage > 0) {
      lastPageWasPartial = true;
      cursor += 1;
      params.setMeta(params.metaKeys.backfillCursor, String(cursor));
    } else if (yielded < limit) {
      lastPageWasPartial = true;
    }
  }

  let nextBackfillCursor: number | null = cursor;
  if (lastPageWasPartial) {
    const completedAt = isoNow();
    params.setMeta(params.metaKeys.backfillCompletedAt, completedAt);
    nextBackfillCursor = null;
  }

  emitProgress("complete");

  return {
    mode: "backfill",
    entity: "issues",
    repo: params.repoName,
    processedPrs: 0,
    processedIssues,
    skippedPrs: 0,
    skippedIssues: 0,
    docCount: params.countRows("search_docs"),
    commentCount: params.countRows("pr_comments"),
    labelCount: params.countRows("issue_labels"),
    vectorAvailable: params.vectorAvailable,
    lastSyncAt: null,
    lastSyncWatermark: null,
    nextBackfillCursor,
  };
}
