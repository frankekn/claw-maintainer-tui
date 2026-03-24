import * as path from "node:path";

const XREF_STOP_WORDS = new Set([
  "after",
  "again",
  "content",
  "issue",
  "message",
  "still",
  "their",
  "there",
  "users",
  "using",
]);

const PATH_TERM_STOP_WORDS = new Set([
  "src",
  "app",
  "lib",
  "dist",
  "build",
  "docs",
  "doc",
  "test",
  "tests",
  "spec",
  "specs",
  "fixtures",
  "fixture",
  "scripts",
  "script",
  "internal",
  "shared",
  "common",
  "utils",
  "index",
]);

export type ChangedFileTerm = {
  kind: "stem" | "dir" | "dir_pair";
  value: string;
};

export function normalizeSearchText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export function buildCrossReferenceQuery(title: string, body: string): string {
  const normalizedBody = normalizeSearchText(body);
  const firstSentence = normalizedBody
    .split(/[\n.!?]+/g)
    .map((value) => value.trim())
    .find(Boolean);
  const source =
    firstSentence && firstSentence.length >= 24 ? firstSentence : title || normalizedBody;
  const terms = Array.from(
    new Set(
      (source.match(/[\p{L}\p{N}_]+/gu) ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length >= 5 && !XREF_STOP_WORDS.has(value.toLowerCase())),
    ),
  )
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .slice(0, 4);
  if (terms.length > 0) {
    return terms.join(" ");
  }
  return normalizeSearchText(title) || normalizedBody;
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function getFileStem(filePath: string): string {
  const baseName = path.basename(filePath).toLowerCase();
  return baseName.replace(/\.(test|spec)(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, "");
}

function normalizePathSegment(value: string): string {
  return value.trim().toLowerCase();
}

function isUsefulPathSegment(value: string): boolean {
  return value.length >= 3 && /^[\p{L}\p{N}_-]+$/u.test(value) && !PATH_TERM_STOP_WORDS.has(value);
}

export function extractChangedFileTerms(filePath: string): ChangedFileTerm[] {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const out = new Map<string, ChangedFileTerm>();
  const stem = normalizePathSegment(getFileStem(normalizedPath));
  if (isUsefulPathSegment(stem)) {
    out.set(`stem:${stem}`, { kind: "stem", value: stem });
  }

  const dirSegments = path
    .dirname(normalizedPath)
    .split(/[\\/]/g)
    .map(normalizePathSegment)
    .filter(isUsefulPathSegment);
  for (const segment of dirSegments) {
    out.set(`dir:${segment}`, { kind: "dir", value: segment });
  }
  for (let index = 1; index < dirSegments.length; index += 1) {
    const pair = `${dirSegments[index - 1]!}/${dirSegments[index]!}`;
    out.set(`dir_pair:${pair}`, { kind: "dir_pair", value: pair });
  }

  return Array.from(out.values()).sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value),
  );
}

export function isCompanionTest(prodPath: string, testPath: string): boolean {
  const prodStem = getFileStem(prodPath);
  const testStem = getFileStem(testPath);
  if (!prodStem || !testStem || prodStem !== testStem) {
    return false;
  }
  const prodDir = path.dirname(prodPath);
  const testDir = path.dirname(testPath);
  return testDir === prodDir || testDir.endsWith(prodDir) || prodDir.endsWith(testDir);
}

export function normalizeClusterSearchTitle(title: string): string {
  return title.replace(/^[a-z0-9_-]+(?:\([^)]*\))?:\s*/i, "").trim();
}

export function extractSemanticTerms(...values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .flatMap((value) => normalizeSearchText(value).match(/[\p{L}\p{N}_-]+/gu) ?? [])
        .map((value) => value.toLowerCase())
        .filter((value) => value.length >= 4 && !XREF_STOP_WORDS.has(value)),
    ),
  ).sort((left, right) => right.length - left.length || left.localeCompare(right));
}
