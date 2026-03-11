import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  HydratedPullRequest,
  IssueDataSource,
  IssueRecord,
  PullRequestCommentRecord,
  PullRequestDataSource,
  PullRequestRecord,
  RepoRef,
} from "./types.js";

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 100 * 1024 * 1024;
const PAGE_SIZE = 100;
const DEFAULT_GH_API_ATTEMPTS = 4;
const DEFAULT_GH_API_BACKOFF_MS = 1000;

type RestPullRequest = {
  number: number;
  title?: string | null;
  body?: string | null;
  draft?: boolean | null;
  state?: "open" | "closed" | null;
  user?: { login?: string | null } | null;
  base?: { ref?: string | null } | null;
  head?: { ref?: string | null } | null;
  html_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  merged_at?: string | null;
  labels?: Array<{ name?: string | null }> | null;
};

type RestIssueComment = {
  id: number;
  body?: string | null;
  user?: { login?: string | null } | null;
  html_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type RestIssue = {
  number: number;
  title?: string | null;
  body?: string | null;
  state?: "open" | "closed" | null;
  user?: { login?: string | null } | null;
  html_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  labels?: Array<{ name?: string | null }> | null;
  pull_request?: Record<string, unknown> | null;
};

type RestReview = {
  id: number;
  body?: string | null;
  user?: { login?: string | null } | null;
  html_url?: string | null;
  submitted_at?: string | null;
};

type RestReviewComment = {
  id: number;
  body?: string | null;
  user?: { login?: string | null } | null;
  html_url?: string | null;
  path?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type GhApiRunner = (path: string) => Promise<string>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPrState(value: RestPullRequest): "open" | "closed" | "merged" {
  if (value.merged_at) {
    return "merged";
  }
  return value.state === "open" ? "open" : "closed";
}

function normalizeLabels(labels: RestPullRequest["labels"]): string[] {
  const out = new Set<string>();
  for (const label of labels ?? []) {
    const name = label?.name?.trim();
    if (name) {
      out.add(name);
    }
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function toPullRequestRecord(value: RestPullRequest): PullRequestRecord {
  return {
    number: value.number,
    title: value.title?.trim() ?? "",
    body: value.body ?? "",
    state: toPrState(value),
    isDraft: Boolean(value.draft),
    author: value.user?.login?.trim() ?? "",
    baseRef: value.base?.ref?.trim() ?? "",
    headRef: value.head?.ref?.trim() ?? "",
    url: value.html_url?.trim() ?? "",
    createdAt: value.created_at ?? new Date(0).toISOString(),
    updatedAt: value.updated_at ?? new Date(0).toISOString(),
    closedAt: value.closed_at ?? null,
    mergedAt: value.merged_at ?? null,
    labels: normalizeLabels(value.labels),
  };
}

function toIssueRecord(value: RestIssue): IssueRecord {
  return {
    number: value.number,
    title: value.title?.trim() ?? "",
    body: value.body ?? "",
    state: value.state === "open" ? "open" : "closed",
    author: value.user?.login?.trim() ?? "",
    url: value.html_url?.trim() ?? "",
    createdAt: value.created_at ?? new Date(0).toISOString(),
    updatedAt: value.updated_at ?? new Date(0).toISOString(),
    closedAt: value.closed_at ?? null,
    labels: normalizeLabels(value.labels),
  };
}

function toIssueCommentRecord(value: RestIssueComment): PullRequestCommentRecord | null {
  const body = value.body?.trim() ?? "";
  if (!body) {
    return null;
  }
  return {
    sourceId: `issue:${value.id}`,
    kind: "issue_comment",
    author: value.user?.login?.trim() ?? "",
    body,
    path: null,
    url: value.html_url?.trim() ?? "",
    createdAt: value.created_at ?? new Date(0).toISOString(),
    updatedAt: value.updated_at ?? value.created_at ?? new Date(0).toISOString(),
  };
}

function toReviewRecord(value: RestReview): PullRequestCommentRecord | null {
  const body = value.body?.trim() ?? "";
  if (!body) {
    return null;
  }
  const submittedAt = value.submitted_at ?? new Date(0).toISOString();
  return {
    sourceId: `review:${value.id}`,
    kind: "review",
    author: value.user?.login?.trim() ?? "",
    body,
    path: null,
    url: value.html_url?.trim() ?? "",
    createdAt: submittedAt,
    updatedAt: submittedAt,
  };
}

function toReviewCommentRecord(value: RestReviewComment): PullRequestCommentRecord | null {
  const body = value.body?.trim() ?? "";
  if (!body) {
    return null;
  }
  return {
    sourceId: `review_comment:${value.id}`,
    kind: "review_comment",
    author: value.user?.login?.trim() ?? "",
    body,
    path: value.path?.trim() ?? null,
    url: value.html_url?.trim() ?? "",
    createdAt: value.created_at ?? new Date(0).toISOString(),
    updatedAt: value.updated_at ?? value.created_at ?? new Date(0).toISOString(),
  };
}

async function ghApiRaw(path: string): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["api", path], {
    maxBuffer: GH_MAX_BUFFER,
  });
  return stdout;
}

export function isRetryableGhApiError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return [
    "connection reset by peer",
    "timed out",
    "timeout",
    "tls handshake timeout",
    "temporary failure",
    "eof",
    "connection refused",
    "too many requests",
    "http 429",
    "http 500",
    "http 502",
    "http 503",
    "http 504",
  ].some((needle) => message.includes(needle));
}

export async function ghApiJsonWithRetry<T>(
  path: string,
  options: {
    runner?: GhApiRunner;
    attempts?: number;
    backoffMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const runner = options.runner ?? ghApiRaw;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_GH_API_ATTEMPTS);
  const backoffMs = Math.max(0, options.backoffMs ?? DEFAULT_GH_API_BACKOFF_MS);
  const sleepFn = options.sleepFn ?? sleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const raw = await runner(path);
      return JSON.parse(raw) as T;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableGhApiError(error)) {
        throw error;
      }
      await sleepFn(backoffMs * attempt);
    }
  }
  throw lastError;
}

async function collectPaginated<T>(pathBuilder: (page: number) => string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page += 1) {
    const pageItems = await ghApiJsonWithRetry<T[]>(pathBuilder(page));
    if (pageItems.length === 0) {
      break;
    }
    out.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) {
      break;
    }
  }
  return out;
}

export class GhCliPullRequestDataSource implements PullRequestDataSource, IssueDataSource {
  async *listAllPullRequests(repo: RepoRef): AsyncGenerator<PullRequestRecord> {
    for (let page = 1; ; page += 1) {
      const items = await ghApiJsonWithRetry<RestPullRequest[]>(
        `repos/${repo.owner}/${repo.name}/pulls?state=all&sort=created&direction=asc&per_page=${PAGE_SIZE}&page=${page}`,
      );
      if (items.length === 0) {
        break;
      }
      for (const item of items) {
        yield toPullRequestRecord(item);
      }
      if (items.length < PAGE_SIZE) {
        break;
      }
    }
  }

  async listChangedPullRequestNumbersSince(repo: RepoRef, since: string): Promise<number[]> {
    const items = await collectPaginated<{
      number: number;
      pull_request?: Record<string, unknown> | null;
    }>(
      (page) =>
        `repos/${repo.owner}/${repo.name}/issues?state=all&sort=updated&direction=desc&since=${encodeURIComponent(
          since,
        )}&per_page=${PAGE_SIZE}&page=${page}`,
    );
    const seen = new Set<number>();
    for (const item of items) {
      if (item.pull_request && Number.isInteger(item.number)) {
        seen.add(item.number);
      }
    }
    return Array.from(seen).sort((a, b) => a - b);
  }

  async *listAllIssues(repo: RepoRef): AsyncGenerator<IssueRecord> {
    for (let page = 1; ; page += 1) {
      const items = await ghApiJsonWithRetry<RestIssue[]>(
        `repos/${repo.owner}/${repo.name}/issues?state=all&sort=created&direction=asc&per_page=${PAGE_SIZE}&page=${page}`,
      );
      if (items.length === 0) {
        break;
      }
      for (const item of items) {
        if (item.pull_request) {
          continue;
        }
        yield toIssueRecord(item);
      }
      if (items.length < PAGE_SIZE) {
        break;
      }
    }
  }

  async listChangedIssueNumbersSince(repo: RepoRef, since: string): Promise<number[]> {
    const items = await collectPaginated<RestIssue>(
      (page) =>
        `repos/${repo.owner}/${repo.name}/issues?state=all&sort=updated&direction=desc&since=${encodeURIComponent(
          since,
        )}&per_page=${PAGE_SIZE}&page=${page}`,
    );
    const seen = new Set<number>();
    for (const item of items) {
      if (!item.pull_request && Number.isInteger(item.number)) {
        seen.add(item.number);
      }
    }
    return Array.from(seen).sort((a, b) => a - b);
  }

  async getIssue(repo: RepoRef, issueNumber: number): Promise<IssueRecord> {
    const issue = await ghApiJsonWithRetry<RestIssue>(
      `repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    );
    if (issue.pull_request) {
      throw new Error(`#${issueNumber} is a pull request, not an issue`);
    }
    return toIssueRecord(issue);
  }

  async hydratePullRequest(repo: RepoRef, prNumber: number): Promise<HydratedPullRequest> {
    const pr = await ghApiJsonWithRetry<RestPullRequest>(
      `repos/${repo.owner}/${repo.name}/pulls/${prNumber}`,
    );
    const [issueComments, reviews, reviewComments] = await Promise.all([
      collectPaginated<RestIssueComment>(
        (page) =>
          `repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments?per_page=${PAGE_SIZE}&page=${page}`,
      ),
      collectPaginated<RestReview>(
        (page) =>
          `repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews?per_page=${PAGE_SIZE}&page=${page}`,
      ),
      collectPaginated<RestReviewComment>(
        (page) =>
          `repos/${repo.owner}/${repo.name}/pulls/${prNumber}/comments?per_page=${PAGE_SIZE}&page=${page}`,
      ),
    ]);

    const comments = [
      ...issueComments.map(toIssueCommentRecord),
      ...reviews.map(toReviewRecord),
      ...reviewComments.map(toReviewCommentRecord),
    ].filter((value): value is PullRequestCommentRecord => Boolean(value));

    comments.sort((a, b) => {
      const byCreated = a.createdAt.localeCompare(b.createdAt);
      if (byCreated !== 0) {
        return byCreated;
      }
      return a.sourceId.localeCompare(b.sourceId);
    });

    return {
      pr: toPullRequestRecord(pr),
      comments,
    };
  }
}

export function parseRepoRef(value: string): RepoRef {
  const trimmed = value.trim();
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid repo '${value}'. Expected owner/name.`);
  }
  return { owner: match[1]!, name: match[2]! };
}
