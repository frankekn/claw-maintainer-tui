import type { IssueSearchFilters, ParsedSearchQuery, SearchFilters } from "../types.js";

function parseQuotedValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  let remaining = raw.trim();
  const filters: SearchFilters = { labels: [] };

  remaining = remaining.replace(/#(\d+)/g, (_, value: string) => {
    filters.prNumber = Number(value);
    return " ";
  });

  remaining = remaining.replace(/label:(".*?"|\S+)/g, (_, value: string) => {
    filters.labels.push(parseQuotedValue(value));
    return " ";
  });

  remaining = remaining.replace(/state:(open|closed|merged|all)\b/gi, (_, value: string) => {
    filters.state = value.toLowerCase() as SearchFilters["state"];
    return " ";
  });

  remaining = remaining.replace(/author:(\S+)/gi, (_, value: string) => {
    filters.author = value.trim();
    return " ";
  });

  remaining = remaining.replace(/branch:(\S+)/gi, (_, value: string) => {
    filters.branch = value.trim();
    return " ";
  });

  filters.labels = uniqueSorted(filters.labels);
  return {
    raw,
    text: remaining.replace(/\s+/g, " ").trim(),
    filters,
  };
}

export function parseIssueSearchQuery(raw: string): {
  raw: string;
  text: string;
  filters: IssueSearchFilters;
} {
  let remaining = raw.trim();
  const filters: IssueSearchFilters = { labels: [] };

  remaining = remaining.replace(/#(\d+)/g, (_, value: string) => {
    filters.issueNumber = Number(value);
    return " ";
  });

  remaining = remaining.replace(/label:(".*?"|\S+)/g, (_, value: string) => {
    filters.labels.push(parseQuotedValue(value));
    return " ";
  });

  remaining = remaining.replace(/state:(open|closed|all)\b/gi, (_, value: string) => {
    filters.state = value.toLowerCase() as IssueSearchFilters["state"];
    return " ";
  });

  remaining = remaining.replace(/author:(\S+)/gi, (_, value: string) => {
    filters.author = value.trim();
    return " ";
  });

  filters.labels = uniqueSorted(filters.labels);
  return {
    raw,
    text: remaining.replace(/\s+/g, " ").trim(),
    filters,
  };
}
