import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSkippedSummary, parseArgs, printSyncSummary, runCli } from "./cli.js";

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
