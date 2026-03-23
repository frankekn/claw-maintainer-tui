import type { PullRequestRecord } from "../types.js";

export const UPSERT_PULL_REQUEST_SQL = `INSERT INTO prs (
  number, title, body, state, is_draft, author, base_ref, head_ref, url,
  created_at, updated_at, closed_at, merged_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(number) DO UPDATE SET
  title = excluded.title,
  body = excluded.body,
  state = excluded.state,
  is_draft = excluded.is_draft,
  author = excluded.author,
  base_ref = excluded.base_ref,
  head_ref = excluded.head_ref,
  url = excluded.url,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  closed_at = excluded.closed_at,
  merged_at = excluded.merged_at`;

export function pullRequestUpsertParams(pr: PullRequestRecord): Array<string | number | null> {
  return [
    pr.number,
    pr.title,
    pr.body,
    pr.state,
    pr.isDraft ? 1 : 0,
    pr.author,
    pr.baseRef,
    pr.headRef,
    pr.url,
    pr.createdAt,
    pr.updatedAt,
    pr.closedAt,
    pr.mergedAt,
  ];
}
