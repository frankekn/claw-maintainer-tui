import type { IssueSearchFilters, SearchFilters } from "../types.js";

export type SqlFilter = {
  sql: string;
  params: Array<string | number>;
};

export function buildPrFilterClause(filters: SearchFilters, prAlias: string): SqlFilter {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filters.prNumber !== undefined) {
    clauses.push(`${prAlias}.number = ?`);
    params.push(filters.prNumber);
  }
  if (filters.state && filters.state !== "all") {
    clauses.push(`${prAlias}.state = ?`);
    params.push(filters.state);
  }
  if (filters.author) {
    clauses.push(`${prAlias}.author = ?`);
    params.push(filters.author);
  }
  if (filters.branch) {
    clauses.push(`(${prAlias}.base_ref = ? OR ${prAlias}.head_ref = ?)`);
    params.push(filters.branch, filters.branch);
  }
  for (const label of filters.labels) {
    clauses.push(
      `EXISTS (SELECT 1 FROM pr_labels pl WHERE pl.pr_number = ${prAlias}.number AND pl.label_name = ?)`,
    );
    params.push(label);
  }

  return {
    sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

export function buildIssueFilterClause(filters: IssueSearchFilters, issueAlias: string): SqlFilter {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filters.issueNumber !== undefined) {
    clauses.push(`${issueAlias}.number = ?`);
    params.push(filters.issueNumber);
  }
  if (filters.state && filters.state !== "all") {
    clauses.push(`${issueAlias}.state = ?`);
    params.push(filters.state);
  }
  if (filters.author) {
    clauses.push(`${issueAlias}.author = ?`);
    params.push(filters.author);
  }
  for (const label of filters.labels) {
    clauses.push(
      `EXISTS (SELECT 1 FROM issue_labels il WHERE il.issue_number = ${issueAlias}.number AND il.label_name = ?)`,
    );
    params.push(label);
  }

  return {
    sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}
