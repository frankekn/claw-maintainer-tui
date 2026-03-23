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
