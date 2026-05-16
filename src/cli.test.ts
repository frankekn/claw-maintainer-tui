import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSkippedSummary, parseArgs, printSyncSummary, runCli } from "./cli.js";
import type { PlannerDecision } from "./sync-planner.js";
import type { StatusSnapshot, SyncSummary } from "./types.js";

function baseSyncSummary(mode: SyncSummary["mode"], entity: SyncSummary["entity"]): SyncSummary {
  return {
    mode,
    entity,
    repo: "openclaw/openclaw",
    processedPrs: 0,
    processedIssues: 0,
    skippedPrs: 0,
    skippedIssues: 0,
    docCount: 0,
    commentCount: 0,
    labelCount: 0,
    vectorAvailable: false,
    lastSyncAt: null,
    lastSyncWatermark: null,
  };
}

function baseStatus(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    repo: "openclaw/openclaw",
    lastSyncAt: null,
    lastSyncWatermark: null,
    issueLastSyncAt: null,
    issueLastSyncWatermark: null,
    prHotSyncAt: null,
    issueHotSyncAt: null,
    prBackfillCursor: null,
    prBackfillCompletedAt: null,
    issueBackfillCursor: null,
    issueBackfillCompletedAt: null,
    prCount: 0,
    issueCount: 0,
    labelCount: 0,
    issueLabelCount: 0,
    commentCount: 0,
    docCount: 0,
    vectorEnabled: false,
    vectorAvailable: false,
    embeddingModel: "test",
    ...overrides,
  };
}

async function loadCliWithPlannerMocks(params: {
  status: StatusSnapshot;
  rateLimit: { limit: number; remaining: number; resetAt: string } | null;
  decision?: PlannerDecision;
}) {
  vi.resetModules();
  const statusMock = vi.fn().mockResolvedValue(params.status);
  const syncMock = vi
    .fn()
    .mockImplementation((options: { full?: boolean }) =>
      Promise.resolve(baseSyncSummary(options.full ? "full" : "incremental", "prs")),
    );
  const syncIssuesMock = vi.fn().mockResolvedValue(baseSyncSummary("incremental", "issues"));
  const syncHotPullRequestsMock = vi.fn().mockResolvedValue(baseSyncSummary("hot", "prs"));
  const syncHotIssuesMock = vi.fn().mockResolvedValue(baseSyncSummary("hot", "issues"));
  const runBackfillSliceMock = vi
    .fn()
    .mockImplementation((options: { entity: SyncSummary["entity"] }) =>
      Promise.resolve(baseSyncSummary("backfill", options.entity)),
    );

  class FakePrIndexStore {
    status = statusMock;
    sync = syncMock;
    syncIssues = syncIssuesMock;
    syncHotPullRequests = syncHotPullRequestsMock;
    syncHotIssues = syncHotIssuesMock;
    runBackfillSlice = runBackfillSliceMock;
  }
  const getRateLimitStatusMock = vi.fn().mockResolvedValue(params.rateLimit);
  class FakeGhCli {
    getRateLimitStatus = getRateLimitStatusMock;
  }

  vi.doMock("./store.js", () => ({ PrIndexStore: FakePrIndexStore }));
  vi.doMock("./github.js", async () => {
    const actual = await vi.importActual<typeof import("./github.js")>("./github.js");
    return {
      ...actual,
      GhCliPullRequestDataSource: FakeGhCli,
    };
  });
  const forcedDecision = params.decision;
  if (forcedDecision) {
    vi.doMock("./sync-planner.js", async () => {
      const actual = await vi.importActual<typeof import("./sync-planner.js")>("./sync-planner.js");
      return {
        ...actual,
        selectSyncDecision: vi.fn().mockReturnValue(forcedDecision),
      };
    });
  }

  const { runCli: runCliReloaded } = await import("./cli.js");
  return {
    runCliReloaded,
    statusMock,
    getRateLimitStatusMock,
    syncMock,
    syncIssuesMock,
    syncHotPullRequestsMock,
    syncHotIssuesMock,
    runBackfillSliceMock,
  };
}

describe("runCli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints usage to stdout and exits 0 for help", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["--help"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("prints usage to stderr and exits 1 for an invalid command", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["wat"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("rejects inherited prototype command keys", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["toString"]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("parseArgs sync planner flags", () => {
  it("parses sync --hot", () => {
    const args = parseArgs(["sync", "--hot", "--repo", "openclaw/openclaw"]);
    expect(args.command).toBe("sync");
    expect(args.hot).toBe(true);
    expect(args.backfill).toBe(false);
    expect(args.full).toBe(false);
  });

  it("parses sync --backfill", () => {
    const args = parseArgs(["sync", "--backfill", "--repo", "openclaw/openclaw"]);
    expect(args.command).toBe("sync");
    expect(args.backfill).toBe(true);
    expect(args.hot).toBe(false);
    expect(args.full).toBe(false);
  });

  it("parses sync-issues --hot", () => {
    const args = parseArgs(["sync-issues", "--hot", "--repo", "openclaw/openclaw"]);
    expect(args.command).toBe("sync-issues");
    expect(args.hot).toBe(true);
  });

  it("parses sync-issues --backfill", () => {
    const args = parseArgs(["sync-issues", "--backfill", "--repo", "openclaw/openclaw"]);
    expect(args.command).toBe("sync-issues");
    expect(args.backfill).toBe(true);
  });

  it("rejects sync --hot --backfill as mutually exclusive", () => {
    expect(() => parseArgs(["sync", "--hot", "--backfill"])).toThrow(/mutually exclusive/);
  });

  it("rejects sync --hot --full as mutually exclusive", () => {
    expect(() => parseArgs(["sync", "--hot", "--full"])).toThrow(/mutually exclusive/);
  });

  it("rejects sync --backfill --full as mutually exclusive", () => {
    expect(() => parseArgs(["sync", "--backfill", "--full"])).toThrow(/mutually exclusive/);
  });

  it("rejects sync --hot --backfill --full as mutually exclusive", () => {
    expect(() => parseArgs(["sync", "--hot", "--backfill", "--full"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("rejects --hot on non-sync commands", () => {
    expect(() => parseArgs(["status", "--hot"])).toThrow(/only valid for sync and sync-issues/);
  });
});

describe("printSyncSummary output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a skipped summary with reason: rate_limit_reserve", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });

    const repo = { owner: "openclaw", name: "openclaw" };
    const summary = makeSkippedSummary("prs", repo, "rate_limit_reserve");
    const exitCode = printSyncSummary(summary, { includeDocs: true });

    expect(exitCode).toBe(0);
    expect(logs).toContain("mode: skipped");
    expect(logs).toContain("reason: rate_limit_reserve");
    expect(logs).toContain("last_sync_at: ");
    expect(logs).toContain("last_sync_watermark: ");
  });

  it("renders next_backfill_cursor for a backfill summary", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });

    const exitCode = printSyncSummary(
      {
        mode: "backfill",
        entity: "prs",
        repo: "openclaw/openclaw",
        processedPrs: 0,
        processedIssues: 0,
        skippedPrs: 0,
        skippedIssues: 0,
        docCount: 0,
        commentCount: 0,
        labelCount: 0,
        vectorAvailable: false,
        lastSyncAt: null,
        lastSyncWatermark: null,
        nextBackfillCursor: 14,
      },
      { includeDocs: true },
    );

    expect(exitCode).toBe(0);
    expect(logs).toContain("mode: backfill");
    expect(logs).toContain("next_backfill_cursor: 14");
  });
});

describe("runCli planner backfill fallback dispatch", () => {
  const originalEnv = process.env.CLAWLENS_SYNC_PLANNER;
  const moderateRateLimit = {
    limit: 5000,
    remaining: 250,
    resetAt: "2026-05-16T00:00:00.000Z",
  };

  beforeEach(() => {
    delete process.env.CLAWLENS_SYNC_PLANNER;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAWLENS_SYNC_PLANNER;
    } else {
      process.env.CLAWLENS_SYNC_PLANNER = originalEnv;
    }
    vi.doUnmock("./store.js");
    vi.doUnmock("./github.js");
    vi.doUnmock("./sync-planner.js");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("dispatches sync --backfill hot fallback to syncHotPullRequests without legacy sync", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runCliReloaded, syncMock, syncHotPullRequestsMock, runBackfillSliceMock } =
      await loadCliWithPlannerMocks({
        status: baseStatus(),
        rateLimit: moderateRateLimit,
      });

    const code = await runCliReloaded([
      "sync",
      "--backfill",
      "--repo",
      "openclaw/openclaw",
      "--db",
      "/tmp/clawlens-cli-test.sqlite",
    ]);

    expect(code).toBe(0);
    expect(syncHotPullRequestsMock).toHaveBeenCalledTimes(1);
    expect(runBackfillSliceMock).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("mode: hot");
  });

  it("preserves sync --backfill hydrate-all on incremental fallback", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const freshWatermark = new Date().toISOString();
    const { runCliReloaded, syncMock, syncHotPullRequestsMock, runBackfillSliceMock } =
      await loadCliWithPlannerMocks({
        status: baseStatus({
          lastSyncAt: freshWatermark,
          lastSyncWatermark: freshWatermark,
        }),
        rateLimit: moderateRateLimit,
      });

    const code = await runCliReloaded([
      "sync",
      "--backfill",
      "--hydrate-all",
      "--repo",
      "openclaw/openclaw",
      "--db",
      "/tmp/clawlens-cli-test.sqlite",
    ]);

    expect(code).toBe(0);
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledWith(
      expect.objectContaining({ full: false, hydrateAll: true }),
    );
    expect(syncHotPullRequestsMock).not.toHaveBeenCalled();
    expect(runBackfillSliceMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("mode: incremental");
  });

  it("preserves sync --hot hydrate-all on full fallback dispatch", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runCliReloaded, syncMock, syncHotPullRequestsMock, runBackfillSliceMock } =
      await loadCliWithPlannerMocks({
        status: baseStatus(),
        rateLimit: moderateRateLimit,
        decision: { kind: "run", mode: "full", reason: "test_full_fallback" },
      });

    const code = await runCliReloaded([
      "sync",
      "--hot",
      "--hydrate-all",
      "--repo",
      "openclaw/openclaw",
      "--db",
      "/tmp/clawlens-cli-test.sqlite",
    ]);

    expect(code).toBe(0);
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledWith(
      expect.objectContaining({ full: true, hydrateAll: true }),
    );
    expect(syncHotPullRequestsMock).not.toHaveBeenCalled();
    expect(runBackfillSliceMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("mode: full");
  });

  it("dispatches sync-issues --backfill hot fallback to syncHotIssues without legacy sync", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runCliReloaded, syncIssuesMock, syncHotIssuesMock, runBackfillSliceMock } =
      await loadCliWithPlannerMocks({
        status: baseStatus(),
        rateLimit: moderateRateLimit,
      });

    const code = await runCliReloaded([
      "sync-issues",
      "--backfill",
      "--repo",
      "openclaw/openclaw",
      "--db",
      "/tmp/clawlens-cli-test.sqlite",
    ]);

    expect(code).toBe(0);
    expect(syncHotIssuesMock).toHaveBeenCalledTimes(1);
    expect(runBackfillSliceMock).not.toHaveBeenCalled();
    expect(syncIssuesMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("mode: hot");
  });

  it("dispatches sync-issues --backfill incremental fallback with full disabled", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const freshWatermark = new Date().toISOString();
    const { runCliReloaded, syncIssuesMock, syncHotIssuesMock, runBackfillSliceMock } =
      await loadCliWithPlannerMocks({
        status: baseStatus({
          issueLastSyncAt: freshWatermark,
          issueLastSyncWatermark: freshWatermark,
        }),
        rateLimit: moderateRateLimit,
      });

    const code = await runCliReloaded([
      "sync-issues",
      "--backfill",
      "--repo",
      "openclaw/openclaw",
      "--db",
      "/tmp/clawlens-cli-test.sqlite",
    ]);

    expect(code).toBe(0);
    expect(syncIssuesMock).toHaveBeenCalledTimes(1);
    expect(syncIssuesMock).toHaveBeenCalledWith(expect.objectContaining({ full: false }));
    expect(syncHotIssuesMock).not.toHaveBeenCalled();
    expect(runBackfillSliceMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("mode: incremental");
  });
});

describe("runCli planner flag short-circuit", () => {
  const originalEnv = process.env.CLAWLENS_SYNC_PLANNER;

  beforeEach(() => {
    process.env.CLAWLENS_SYNC_PLANNER = "off";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAWLENS_SYNC_PLANNER;
    } else {
      process.env.CLAWLENS_SYNC_PLANNER = originalEnv;
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("short-circuits sync --hot to the legacy store.sync path when planner is disabled", async () => {
    vi.resetModules();
    const syncMock = vi.fn().mockResolvedValue({
      mode: "incremental",
      entity: "prs",
      repo: "openclaw/openclaw",
      processedPrs: 0,
      processedIssues: 0,
      skippedPrs: 0,
      skippedIssues: 0,
      docCount: 0,
      commentCount: 0,
      labelCount: 0,
      vectorAvailable: false,
      lastSyncAt: null,
      lastSyncWatermark: null,
    });
    const syncHotMock = vi.fn();
    const runBackfillMock = vi.fn();
    class FakePrIndexStore {
      sync = syncMock;
      syncHotPullRequests = syncHotMock;
      runBackfillSlice = runBackfillMock;
    }
    class FakeGhCli {
      getRateLimitStatus = vi.fn().mockResolvedValue(null);
    }
    vi.doMock("./store.js", () => ({ PrIndexStore: FakePrIndexStore }));
    vi.doMock("./github.js", async () => {
      const actual = await vi.importActual<typeof import("./github.js")>("./github.js");
      return {
        ...actual,
        GhCliPullRequestDataSource: FakeGhCli,
      };
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { runCli: runCliReloaded } = await import("./cli.js");
    const code = await runCliReloaded([
      "sync",
      "--hot",
      "--repo",
      "openclaw/openclaw",
      "--db",
      "/tmp/clawlens-cli-test.sqlite",
    ]);

    expect(code).toBe(0);
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncHotMock).not.toHaveBeenCalled();
    expect(runBackfillMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("CLAWLENS_SYNC_PLANNER=off"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("mode:"));
  });
});
