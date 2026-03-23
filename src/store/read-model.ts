import { requireNodeSqlite } from "../lib/sqlite.js";
import { mergePullRequestLinkedIssues } from "../lib/pull-request-links.js";
import type {
  PullRequestChangedFile,
  PullRequestLinkedIssue,
  PullRequestLinkSource,
} from "../types.js";

const { DatabaseSync } = requireNodeSqlite();

export type StoreDatabase = InstanceType<typeof DatabaseSync>;

export type PrRow = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  is_draft: number;
  author: string;
  base_ref: string;
  head_ref: string;
  url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
};

export type IssueRow = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author: string;
  url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export function getPrRow(db: StoreDatabase, prNumber: number): PrRow | null {
  return (
    (db.prepare("SELECT * FROM prs WHERE number = ?").get(prNumber) as PrRow | undefined) ?? null
  );
}

export function getIssueRow(db: StoreDatabase, issueNumber: number): IssueRow | null {
  return (
    (db.prepare("SELECT * FROM issues WHERE number = ?").get(issueNumber) as
      | IssueRow
      | undefined) ?? null
  );
}

export function getLinkedIssuesForPr(
  db: StoreDatabase,
  prNumber: number,
): PullRequestLinkedIssue[] {
  const rows = db
    .prepare(
      `SELECT issue_number, link_source
         FROM pr_linked_issues
        WHERE pr_number = ?
        ORDER BY issue_number ASC, link_source ASC`,
    )
    .all(prNumber) as Array<{ issue_number: number; link_source: PullRequestLinkSource }>;
  return mergePullRequestLinkedIssues(
    rows.map((row) => ({
      issueNumber: row.issue_number,
      linkSource: row.link_source,
    })),
  );
}

export function getChangedFilesForPr(
  db: StoreDatabase,
  prNumber: number,
): PullRequestChangedFile[] {
  return db
    .prepare(
      `SELECT path, kind
         FROM pr_changed_files
        WHERE pr_number = ?
        ORDER BY path ASC`,
    )
    .all(prNumber) as PullRequestChangedFile[];
}

export function getLabelsForPr(db: StoreDatabase, prNumber: number): string[] {
  const rows = db
    .prepare("SELECT label_name FROM pr_labels WHERE pr_number = ? ORDER BY label_name ASC")
    .all(prNumber) as Array<{ label_name: string }>;
  return rows.map((row) => row.label_name);
}

export function getLabelsForIssue(db: StoreDatabase, issueNumber: number): string[] {
  const rows = db
    .prepare("SELECT label_name FROM issue_labels WHERE issue_number = ? ORDER BY label_name ASC")
    .all(issueNumber) as Array<{ label_name: string }>;
  return rows.map((row) => row.label_name);
}
