import { describe, expect, it } from "vitest";
import { limitRelatedPullRequests, rankSearchDocRows } from "./search-workflow.js";

describe("search workflow helpers", () => {
  it("prefers keyword hits and falls back to weighted vector hits", () => {
    const ranked = rankSearchDocRows({
      keywordHits: [
        {
          doc_id: "pr:10:body",
          pr_number: 10,
          doc_kind: "pr_body",
          title: "Fix parser",
          text: "parser body",
          updated_at: "2026-03-18T10:00:00.000Z",
          score: 0.9,
        },
      ],
      vectorHits: [
        {
          doc_id: "pr:20:body",
          pr_number: 20,
          doc_kind: "pr_body",
          title: "Related parser cleanup",
          text: "cleanup body",
          updated_at: "2026-03-18T09:00:00.000Z",
          score: 0.8,
        },
        {
          doc_id: "pr:10:body",
          pr_number: 10,
          doc_kind: "pr_body",
          title: "Fix parser",
          text: "parser body",
          updated_at: "2026-03-18T10:00:00.000Z",
          score: 0.4,
        },
      ],
      vectorFallbackWeight: 0.05,
    });

    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toMatchObject({
      pr_number: 10,
      textScore: 0.9,
      vectorScore: 0.4,
    });
    expect(ranked[0].score).toBeCloseTo(0.9);
    expect(ranked[1]).toMatchObject({
      pr_number: 20,
      textScore: 0,
      vectorScore: 0.8,
    });
    expect(ranked[1].score).toBeCloseTo(0.04);
  });

  it("filters the seed pull request from related results", () => {
    const related = limitRelatedPullRequests(
      [
        {
          prNumber: 10,
          title: "Seed",
          url: "https://example.test/pr/10",
          state: "open",
          author: "alice",
          labels: [],
          updatedAt: "2026-03-18T10:00:00.000Z",
          score: 1,
          matchedDocKind: "pr_body",
          matchedExcerpt: "seed",
        },
        {
          prNumber: 11,
          title: "Sibling",
          url: "https://example.test/pr/11",
          state: "open",
          author: "bob",
          labels: [],
          updatedAt: "2026-03-18T09:00:00.000Z",
          score: 0.7,
          matchedDocKind: "comment",
          matchedExcerpt: "sibling",
        },
      ],
      10,
      5,
    );

    expect(related.map((result) => result.prNumber)).toEqual([11]);
  });
});
