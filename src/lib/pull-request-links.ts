import type { PullRequestLinkedIssue, PullRequestLinkSource } from "../types.js";

export const TEXT_DERIVED_PULL_REQUEST_LINK_SOURCES: PullRequestLinkSource[] = [
  "source_issue_marker",
  "body_reference",
  "title_reference",
];

export const FACT_OWNED_PULL_REQUEST_LINK_SOURCES: PullRequestLinkSource[] = ["closing_reference"];

export function isFactOwnedPullRequestLinkSource(linkSource: PullRequestLinkSource): boolean {
  return FACT_OWNED_PULL_REQUEST_LINK_SOURCES.includes(linkSource);
}

export function mergePullRequestLinkedIssues(
  issues: Iterable<PullRequestLinkedIssue>,
): PullRequestLinkedIssue[] {
  const out = new Map<number, PullRequestLinkedIssue>();
  for (const issue of issues) {
    const existing = out.get(issue.issueNumber);
    if (!existing || issue.linkSource === "closing_reference") {
      out.set(issue.issueNumber, issue);
    }
  }
  return Array.from(out.values()).sort((left, right) => left.issueNumber - right.issueNumber);
}

export function toClosingReferenceIssues(issueNumbers: Iterable<number>): PullRequestLinkedIssue[] {
  const out = new Set<number>();
  for (const issueNumber of issueNumbers) {
    if (Number.isInteger(issueNumber) && issueNumber > 0) {
      out.add(issueNumber);
    }
  }
  return Array.from(out)
    .sort((left, right) => left - right)
    .map((issueNumber) => ({
      issueNumber,
      linkSource: "closing_reference",
    }));
}
