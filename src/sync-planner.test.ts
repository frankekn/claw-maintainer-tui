import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_BACKFILL_FLOOR,
  RATE_LIMIT_RESERVE,
  STALE_WATERMARK_MS,
  selectSyncDecision,
} from "./sync-planner.js";
import type {
  PlannerActiveTuiMode,
  PlannerFreshness,
  PlannerMode,
  PlannerRateLimit,
  PlannerSnapshot,
  PlannerTrigger,
} from "./sync-planner.js";

const NOW = Date.parse("2026-05-15T12:00:00Z");

function freshness(overrides: Partial<PlannerFreshness> = {}): PlannerFreshness {
  return {
    lastSyncAt: null,
    lastSyncWatermark: null,
    hotSyncAt: null,
    backfillCursor: null,
    backfillCompletedAt: null,
    ...overrides,
  };
}

function rateLimit(remaining: number): PlannerRateLimit {
  return { limit: 5000, remaining, resetAt: "2026-05-15T13:00:00Z" };
}

function snapshot(overrides: Partial<PlannerSnapshot> = {}): PlannerSnapshot {
  return {
    entity: "prs",
    trigger: "manual",
    manualOverride: null,
    rateLimit: rateLimit(5000),
    freshness: freshness(),
    activeTuiMode: null,
    now: NOW,
    ...overrides,
  };
}

describe("constants", () => {
  it("matches the spec values", () => {
    expect(RATE_LIMIT_RESERVE).toBe(100);
    expect(RATE_LIMIT_BACKFILL_FLOOR).toBe(500);
    expect(STALE_WATERMARK_MS).toBe(15 * 60 * 1000);
  });
});

describe("reserve band", () => {
  it("skips with rate_limit_reserve when remaining is below the reserve floor", () => {
    const decision = selectSyncDecision(snapshot({ rateLimit: rateLimit(99) }));
    expect(decision).toEqual({ kind: "skip", reason: "rate_limit_reserve" });
  });

  it("skips with rate_limit_reserve at exactly remaining = 0", () => {
    const decision = selectSyncDecision(snapshot({ rateLimit: rateLimit(0) }));
    expect(decision).toEqual({ kind: "skip", reason: "rate_limit_reserve" });
  });

  it("skips even with manualOverride: hot in reserve band", () => {
    const decision = selectSyncDecision(
      snapshot({ rateLimit: rateLimit(50), manualOverride: "hot" }),
    );
    expect(decision).toEqual({ kind: "skip", reason: "rate_limit_reserve" });
  });

  it("skips even with manualOverride: incremental in reserve band", () => {
    const decision = selectSyncDecision(
      snapshot({ rateLimit: rateLimit(50), manualOverride: "incremental" }),
    );
    expect(decision).toEqual({ kind: "skip", reason: "rate_limit_reserve" });
  });

  it("skips even with manualOverride: full in reserve band", () => {
    const decision = selectSyncDecision(
      snapshot({ rateLimit: rateLimit(50), manualOverride: "full" }),
    );
    expect(decision).toEqual({ kind: "skip", reason: "rate_limit_reserve" });
  });

  it("skips even with manualOverride: backfill in reserve band", () => {
    const decision = selectSyncDecision(
      snapshot({ rateLimit: rateLimit(50), manualOverride: "backfill" }),
    );
    expect(decision).toEqual({ kind: "skip", reason: "rate_limit_reserve" });
  });

  it("skips even after a recent hot bootstrap pass with no watermark", () => {
    const recentHot = new Date(NOW - 1_000).toISOString();
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(50),
        freshness: freshness({
          lastSyncAt: recentHot,
          lastSyncWatermark: null,
          hotSyncAt: recentHot,
        }),
      }),
    );
    expect(decision).toEqual({ kind: "skip", reason: "rate_limit_reserve" });
  });
});

describe("null rate-limit snapshot (treated as moderate)", () => {
  it("runs hot when no watermark exists", () => {
    const decision = selectSyncDecision(snapshot({ rateLimit: null }));
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("hot");
    }
  });

  it("runs incremental when watermark is fresh", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: null,
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - 1_000).toISOString(),
          lastSyncAt: new Date(NOW - 1_000).toISOString(),
        }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("incremental");
    }
  });

  it("never schedules backfill even with healthy-looking cursor state", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: null,
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - 1_000).toISOString(),
          lastSyncAt: new Date(NOW - 1_000).toISOString(),
          backfillCursor: 12,
        }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).not.toBe<PlannerMode>("backfill");
      expect(decision.mode).toBe<PlannerMode>("incremental");
    }
  });

  it("stays conservative after a recent hot bootstrap pass with no watermark", () => {
    const recentHot = new Date(NOW - 1_000).toISOString();
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: null,
        freshness: freshness({
          lastSyncAt: recentHot,
          lastSyncWatermark: null,
          hotSyncAt: recentHot,
        }),
      }),
    );
    expect(decision).toEqual({ kind: "skip", reason: "already_fresh" });
  });
});

describe("moderate band (>=100 and <500)", () => {
  it("runs hot when no watermark exists", () => {
    const decision = selectSyncDecision(snapshot({ rateLimit: rateLimit(200) }));
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("hot");
    }
  });

  it("stays conservative after a recent hot bootstrap pass with no watermark", () => {
    const recentHot = new Date(NOW - 1_000).toISOString();
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(200),
        freshness: freshness({
          lastSyncAt: recentHot,
          lastSyncWatermark: null,
          hotSyncAt: recentHot,
        }),
      }),
    );
    expect(decision).toEqual({ kind: "skip", reason: "already_fresh" });
  });

  it("runs incremental when watermark is fresh", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(200),
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - 1_000).toISOString(),
          lastSyncAt: new Date(NOW - 1_000).toISOString(),
        }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("incremental");
    }
  });

  it("runs hot when watermark is stale", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(200),
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - STALE_WATERMARK_MS - 5_000).toISOString(),
          lastSyncAt: new Date(NOW - STALE_WATERMARK_MS - 5_000).toISOString(),
        }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("hot");
    }
  });

  it("does NOT schedule backfill even when cursor is open and watermark is fresh", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(200),
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - 1_000).toISOString(),
          lastSyncAt: new Date(NOW - 1_000).toISOString(),
          backfillCursor: 5,
        }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("incremental");
    }
  });

  it("blocks manualOverride: full and falls back to natural mode", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(200),
        manualOverride: "full",
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      // No watermark + override blocked => natural mode is hot.
      expect(decision.mode).toBe<PlannerMode>("hot");
    }
  });

  it("blocks manualOverride: backfill and falls back to natural mode", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(200),
        manualOverride: "backfill",
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - 1_000).toISOString(),
          lastSyncAt: new Date(NOW - 1_000).toISOString(),
          backfillCursor: 5,
        }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("incremental");
    }
  });

  it("honors manualOverride: hot in moderate band", () => {
    const decision = selectSyncDecision(
      snapshot({ rateLimit: rateLimit(200), manualOverride: "hot" }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("hot");
    }
  });

  it("honors manualOverride: incremental in moderate band", () => {
    const decision = selectSyncDecision(
      snapshot({ rateLimit: rateLimit(200), manualOverride: "incremental" }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("incremental");
    }
  });
});

describe("healthy band (>=500)", () => {
  it("runs hot when no watermark exists", () => {
    const decision = selectSyncDecision(snapshot({ rateLimit: rateLimit(2000) }));
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("hot");
    }
  });

  it("schedules backfill after a recent hot bootstrap pass with no watermark", () => {
    const recentHot = new Date(NOW - 1_000).toISOString();
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({
          lastSyncAt: recentHot,
          lastSyncWatermark: null,
          hotSyncAt: recentHot,
        }),
      }),
    );
    expect(decision).toEqual({ kind: "run", mode: "backfill", reason: "bootstrap_backfill" });
  });

  it("schedules backfill in list mode after a recent hot bootstrap pass with no watermark", () => {
    const recentHot = new Date(NOW - 1_000).toISOString();
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({
          lastSyncAt: recentHot,
          lastSyncWatermark: null,
          hotSyncAt: recentHot,
        }),
        activeTuiMode: "pr-search",
      }),
    );
    expect(decision).toEqual({ kind: "run", mode: "backfill", reason: "bootstrap_backfill" });
  });

  it("runs hot when no watermark exists and the bootstrap hot timestamp is stale", () => {
    const staleHot = new Date(NOW - STALE_WATERMARK_MS - 5_000).toISOString();
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({
          lastSyncAt: staleHot,
          lastSyncWatermark: null,
          hotSyncAt: staleHot,
        }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("hot");
    }
  });

  it("schedules backfill when watermark is fresh, cursor is null, and not on a list mode", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - 1_000).toISOString(),
          lastSyncAt: new Date(NOW - 1_000).toISOString(),
        }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("backfill");
    }
  });

  it("runs hot when watermark is stale", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - STALE_WATERMARK_MS - 5_000).toISOString(),
          lastSyncAt: new Date(NOW - STALE_WATERMARK_MS - 5_000).toISOString(),
        }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("hot");
    }
  });

  it("schedules backfill when watermark is fresh, cursor is open, and not on a list mode", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - 1_000).toISOString(),
          lastSyncAt: new Date(NOW - 1_000).toISOString(),
          backfillCursor: 12,
        }),
        activeTuiMode: null,
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("backfill");
    }
  });

  it("does NOT schedule backfill when completion sentinel is set", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - 1_000).toISOString(),
          lastSyncAt: new Date(NOW - 1_000).toISOString(),
          backfillCursor: 12,
          backfillCompletedAt: "2026-04-30T00:00:00Z",
        }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("incremental");
    }
  });

  it("does NOT schedule backfill from a null cursor while on a list mode", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - 1_000).toISOString(),
          lastSyncAt: new Date(NOW - 1_000).toISOString(),
        }),
        activeTuiMode: "issue-search",
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("incremental");
    }
  });

  it("honors manualOverride: full", () => {
    const decision = selectSyncDecision(
      snapshot({ rateLimit: rateLimit(2000), manualOverride: "full" }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("full");
    }
  });

  it("honors manualOverride: backfill", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        manualOverride: "backfill",
        freshness: freshness({ backfillCursor: 5 }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("backfill");
    }
  });

  it("honors manualOverride: hot", () => {
    const decision = selectSyncDecision(
      snapshot({ rateLimit: rateLimit(2000), manualOverride: "hot" }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("hot");
    }
  });

  it("honors manualOverride: incremental", () => {
    const decision = selectSyncDecision(
      snapshot({ rateLimit: rateLimit(2000), manualOverride: "incremental" }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("incremental");
    }
  });
});

describe("STALE_WATERMARK_MS boundary", () => {
  it("treats now - lastSyncAt == STALE_WATERMARK_MS as fresh", () => {
    const lastSyncAt = new Date(NOW - STALE_WATERMARK_MS).toISOString();
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({ lastSyncWatermark: lastSyncAt, lastSyncAt }),
        activeTuiMode: "pr-search",
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("incremental");
    }
  });

  it("treats now - lastSyncAt == STALE_WATERMARK_MS - 1 as fresh", () => {
    const lastSyncAt = new Date(NOW - (STALE_WATERMARK_MS - 1)).toISOString();
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({ lastSyncWatermark: lastSyncAt, lastSyncAt }),
        activeTuiMode: "pr-search",
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("incremental");
    }
  });

  it("treats now - lastSyncAt == STALE_WATERMARK_MS + 1 as stale (hot)", () => {
    const lastSyncAt = new Date(NOW - (STALE_WATERMARK_MS + 1)).toISOString();
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({ lastSyncWatermark: lastSyncAt, lastSyncAt }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("hot");
    }
  });
});

describe("list mode vs non-list mode ordering", () => {
  const listModes: ReadonlyArray<PlannerActiveTuiMode> = [
    "pr-search",
    "issue-search",
    "cross-search",
    "inbox",
    "watchlist",
  ];

  for (const mode of listModes) {
    it(`prefers hot over backfill on stale watermark while in ${mode}`, () => {
      const decision = selectSyncDecision(
        snapshot({
          rateLimit: rateLimit(2000),
          freshness: freshness({
            lastSyncWatermark: new Date(NOW - STALE_WATERMARK_MS - 5_000).toISOString(),
            lastSyncAt: new Date(NOW - STALE_WATERMARK_MS - 5_000).toISOString(),
            backfillCursor: 12,
          }),
          activeTuiMode: mode,
        }),
      );
      expect(decision.kind).toBe("run");
      if (decision.kind === "run") {
        expect(decision.mode).toBe<PlannerMode>("hot");
      }
    });
  }

  it("on a list mode with fresh watermark, does NOT schedule backfill (defers to non-list ticks)", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - 1_000).toISOString(),
          lastSyncAt: new Date(NOW - 1_000).toISOString(),
          backfillCursor: 12,
        }),
        activeTuiMode: "pr-search",
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("incremental");
    }
  });

  it("on no active TUI mode (null) with stale watermark and healthy quota, picks hot (still not backfill)", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - STALE_WATERMARK_MS - 5_000).toISOString(),
          lastSyncAt: new Date(NOW - STALE_WATERMARK_MS - 5_000).toISOString(),
          backfillCursor: 12,
        }),
        activeTuiMode: null,
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("hot");
    }
  });
});

describe("backfill completion sentinel", () => {
  it("skips with backfill_complete when manualOverride is backfill and sentinel is set", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        manualOverride: "backfill",
        freshness: freshness({
          backfillCursor: 12,
          backfillCompletedAt: "2026-04-30T00:00:00Z",
        }),
      }),
    );
    expect(decision).toEqual({ kind: "skip", reason: "backfill_complete" });
  });

  it("manual backfill in moderate band with completion sentinel still skips with backfill_complete", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(200),
        manualOverride: "backfill",
        freshness: freshness({
          backfillCursor: 12,
          backfillCompletedAt: "2026-04-30T00:00:00Z",
        }),
      }),
    );
    expect(decision).toEqual({ kind: "skip", reason: "backfill_complete" });
  });
});

describe("auto trigger constraints", () => {
  it("never picks full on auto trigger without an override when a watermark exists", () => {
    const decision = selectSyncDecision(
      snapshot({
        trigger: "auto",
        rateLimit: rateLimit(2000),
        freshness: freshness({
          lastSyncWatermark: new Date(NOW - 1_000).toISOString(),
          lastSyncAt: new Date(NOW - 1_000).toISOString(),
        }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).not.toBe<PlannerMode>("full");
    }
  });

  it("never picks full on auto trigger without an override even when no watermark exists", () => {
    const decision = selectSyncDecision(snapshot({ trigger: "auto", rateLimit: rateLimit(2000) }));
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).not.toBe<PlannerMode>("full");
    }
  });
});

describe("unparsable lastSyncAt", () => {
  it("treats a non-ISO lastSyncAt as null and prefers hot", () => {
    const decision = selectSyncDecision(
      snapshot({
        rateLimit: rateLimit(2000),
        freshness: freshness({
          lastSyncWatermark: "2026-05-15T11:00:00Z",
          lastSyncAt: "not-a-real-iso-timestamp",
        }),
      }),
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") {
      expect(decision.mode).toBe<PlannerMode>("hot");
    }
  });
});

describe("determinism", () => {
  it("returns identical decisions for two structurally-identical snapshots", () => {
    const makeSnap = (): PlannerSnapshot => ({
      entity: "prs",
      trigger: "auto",
      manualOverride: null,
      rateLimit: { limit: 5000, remaining: 1234, resetAt: "2026-05-15T13:00:00Z" },
      freshness: {
        lastSyncAt: "2026-05-15T11:59:00Z",
        lastSyncWatermark: "2026-05-15T11:59:00Z",
        hotSyncAt: null,
        backfillCursor: 7,
        backfillCompletedAt: null,
      },
      activeTuiMode: "pr-search",
      now: NOW,
    });
    const a = selectSyncDecision(makeSnap());
    const b = selectSyncDecision(makeSnap());
    expect(a).toEqual(b);
  });

  it("returns identical decisions across many entity/trigger combinations", () => {
    const entities: ReadonlyArray<"prs" | "issues"> = ["prs", "issues"];
    const triggers: ReadonlyArray<PlannerTrigger> = ["manual", "auto"];
    for (const entity of entities) {
      for (const trigger of triggers) {
        const snap = snapshot({ entity, trigger, rateLimit: rateLimit(2000) });
        const a = selectSyncDecision(snap);
        const b = selectSyncDecision(snap);
        expect(a).toEqual(b);
      }
    }
  });
});
