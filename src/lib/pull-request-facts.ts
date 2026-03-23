import type {
  PullRequestChangedFileKind,
  PullRequestLinkedIssue,
  PullRequestLinkSource,
} from "../types.js";

function addLinkedIssue(
  out: Map<number, PullRequestLinkedIssue>,
  issueNumber: number,
  linkSource: PullRequestLinkSource,
): void {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return;
  }
  const existing = out.get(issueNumber);
  if (!existing || linkSource === "closing_reference") {
    out.set(issueNumber, { issueNumber, linkSource });
  }
}

export function collectLinkedIssuesFromPrText(
  title: string,
  body: string,
): PullRequestLinkedIssue[] {
  const out = new Map<number, PullRequestLinkedIssue>();
  for (const match of title.matchAll(/\[issue\s+#(\d+)\]/gi)) {
    addLinkedIssue(out, Number(match[1]), "title_reference");
  }
  for (const match of body.matchAll(/\bsource issue\s*#(\d+)\b/gi)) {
    addLinkedIssue(out, Number(match[1]), "source_issue_marker");
  }
  for (const match of body.matchAll(
    /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+((?:#\d+)(?:\s*(?:,|\band\b)\s*#\d+)*)/gi,
  )) {
    for (const issueMatch of match[1].matchAll(/#(\d+)/g)) {
      addLinkedIssue(out, Number(issueMatch[1]), "body_reference");
    }
  }
  return Array.from(out.values()).sort((left, right) => left.issueNumber - right.issueNumber);
}

export function mergeClosingReferenceIssues(
  linkedIssues: PullRequestLinkedIssue[],
  closingIssueNumbers: number[],
): PullRequestLinkedIssue[] {
  const out = new Map<number, PullRequestLinkedIssue>();
  for (const issue of linkedIssues) {
    out.set(issue.issueNumber, issue);
  }
  for (const issueNumber of closingIssueNumbers) {
    addLinkedIssue(out, issueNumber, "closing_reference");
  }
  return Array.from(out.values()).sort((left, right) => left.issueNumber - right.issueNumber);
}

export function classifyChangedFileKind(filePath: string): PullRequestChangedFileKind {
  const normalized = filePath.trim();
  if (
    /(^|\/)(test|tests|__tests__)\//i.test(normalized) ||
    /\.(test|spec)\.[^/.]+$/i.test(normalized)
  ) {
    return "test";
  }
  if (
    !normalized ||
    /(^|\/)(docs|doc|fixtures|examples|scripts|\.github)\//i.test(normalized) ||
    /(^|\/)(readme|changelog|license)(\.[^/]+)?$/i.test(normalized) ||
    /\.(md|mdx|txt|json|ya?ml|toml|lock)$/i.test(normalized)
  ) {
    return "other";
  }
  return "prod";
}
